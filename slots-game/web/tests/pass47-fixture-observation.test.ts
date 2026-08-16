import { describe, expect, it } from "vitest";
import type {
  AppPresentationCheckpoint,
  AppPresentationTrace,
} from "../src/app/AppController";
import type { FeatureEvent } from "../src/app/state/types";
import type { VisualTelemetryEvent } from "../src/renderer/VisualTelemetry";
import fixtureMain from "../src/testing/visualFixturesMain.ts?raw";
import {
  applyPass47PresentationMilestone,
  applyPass47VisualTelemetryEvent,
  applyVisualFixtureFeatureEvent,
  applyVisualFixtureTrace,
  createVisualFixtureCheckpointHold,
  matchVisualFixtureSemanticCheckpoint,
  resolveVisualFixtureSemanticCheckpoint,
  validatePass47SemanticCheckpoint,
  type VisualFixtureDataset,
} from "../src/testing/visualFixtureObservation";

const SCENARIO = "base-one-rage-trigger-transform";
const PHASES = [
  "started",
  "exploding",
  "placed",
  "pound",
  "activation",
  "source-hidden",
  "complete",
] as const;
type Phase = typeof PHASES[number];

const SOURCE_EVENT = Object.freeze({
  type: "surge.collected",
  count: 1,
  cells: Object.freeze([Object.freeze({ reel: 0, row: 1 })]),
  triggered: true,
  guaranteed: false,
  level: 1,
  total: 0,
} as const satisfies FeatureEvent);

const TRANSFORM_EVENT = Object.freeze({
  type: "rage.transformed",
  count: 2,
  cells: Object.freeze([
    Object.freeze({ reel: 1, row: 1 }),
    Object.freeze({ reel: 2, row: 1 }),
  ]),
  level: 1,
  total: 0,
} as const satisfies FeatureEvent);

const WHEEL_STARTED = Object.freeze({ type: "wheel.started" } as const satisfies FeatureEvent);
const WHEEL_AWARDED = Object.freeze({
  type: "wheel.awarded",
  outcome: "INSTANT",
  prize: "MINI",
  multiplier: 10,
  amountMinor: "1000",
} as const satisfies FeatureEvent);

const AUTHORED_AT: Readonly<Record<Phase, number>> = Object.freeze({
  started: 0,
  exploding: 390,
  placed: 930,
  pound: 1_430,
  activation: 1_820,
  "source-hidden": 3_986.7,
  complete: 4_120,
});

const CELL_ORDER = Object.freeze([8, 7, 6, 5, 4, 3, 2, 1, 0]);

function cascadeTrace(
  phase: Phase,
  overrides: Readonly<Record<string, unknown>> = {},
): AppPresentationTrace {
  const activated = phase === "activation" || phase === "source-hidden" || phase === "complete";
  const exploding = phase === "exploding";
  const activation = phase === "activation";
  return {
    type: `rage-cascade.${phase}`,
    sequence: 1,
    authoredAtMs: AUTHORED_AT[phase],
    elapsedMs: AUTHORED_AT[phase],
    reducedMotion: false,
    transformedCells: [{ reel: 1, row: 1 }, { reel: 2, row: 1 }],
    shuffledCells: exploding
      ? CELL_ORDER.map((cellIndex, orderIndex) => ({
          orderIndex,
          cellIndex,
          address: { reel: Math.floor(cellIndex / 3), row: cellIndex % 3 },
          transformsToRage: cellIndex === 4 || cellIndex === 7,
          authoredAtMs: 390 + orderIndex * 60,
          elapsedMs: 390 + orderIndex * 60,
        }))
      : [],
    activationAttempted: activated ? 3 : 0,
    activationPlayed: activated ? 3 : 0,
    shakePhase: exploding ? "respin" : activation ? "pound" : null,
    shakeAuthoredAtMs: exploding ? 400 : activation ? 1_930 : null,
    shakeElapsedMs: exploding ? 400 : activation ? 1_930 : null,
    hidden: phase === "source-hidden" || phase === "complete",
    ...overrides,
  } as unknown as AppPresentationTrace;
}

function accepted(dataset: VisualFixtureDataset): void {
  expect(applyVisualFixtureTrace(dataset, {
    type: "result.accepted",
    sequence: 1,
    roundId: "round-base-one-rage-trigger-transform",
    totalWinMinor: "1000",
    balanceMinor: "100900",
    winCount: 0,
  }, SCENARIO)).toBe(false);
}

function feature(
  dataset: VisualFixtureDataset,
  event: Readonly<FeatureEvent>,
): boolean {
  return applyVisualFixtureFeatureEvent(dataset, event.type, event, SCENARIO);
}

function readyForCascade(dataset: VisualFixtureDataset): void {
  accepted(dataset);
  expect(feature(dataset, SOURCE_EVENT)).toBe(false);
  expect(feature(dataset, TRANSFORM_EVENT)).toBe(false);
}

function telemetry(id: "rage.cascade" | "rage.collect" | "wheel.popup"): VisualTelemetryEvent {
  return {
    schemaVersion: 1,
    kind: "start",
    id,
    operationId: 47,
    requirement: "conditional",
    mode: "authored",
  };
}

describe("Pass47 fixture entry contract", () => {
  it("injects one capture-only permutation and wires strict observation without result mutation", () => {
    expect(fixtureMain).toContain('scenario === "base-one-rage-trigger-transform"');
    expect(fixtureMain).toContain('capture === "1"');
    expect(fixtureMain).toContain("PASS47_RAGE_CASCADE_CELL_ORDER");
    expect(fixtureMain).toContain("rageCascadeCellOrderSource:");
    expect(fixtureMain).toContain("applyPass47VisualTelemetryEvent");
    expect(fixtureMain).toContain("applyPass47PresentationMilestone");
    expect(fixtureMain).toContain("validatePass47SemanticCheckpoint");
    expect(fixtureMain).not.toContain("Math.random");

    const sourceStart = fixtureMain.indexOf("rageCascadeCellOrderSource:");
    const sourceEnd = fixtureMain.indexOf("}, {", sourceStart);
    const sourceGuard = fixtureMain.slice(sourceStart, sourceEnd);
    expect(sourceGuard).toContain('scenario === "base-one-rage-trigger-transform"');
    expect(sourceGuard).toContain('capture === "1"');
    expect(sourceGuard).toContain("? () => PASS47_RAGE_CASCADE_CELL_ORDER");

    const holdStart = fixtureMain.indexOf("const hold = createVisualFixtureCheckpointHold");
    const holdEnd = fixtureMain.indexOf("return hold.promise", holdStart);
    expect(fixtureMain.slice(holdStart, holdEnd))
      .toContain('scenario === "base-one-rage-trigger-transform"');
  });
});

describe("Pass47 Rage-cascade observation", () => {
  it("projects seven exact phases, nine unique cells, 3/3 activation and both shakes", () => {
    const dataset: VisualFixtureDataset = {};
    readyForCascade(dataset);
    expect(applyPass47VisualTelemetryEvent(
      dataset,
      SCENARIO,
      telemetry("rage.cascade"),
    )).toBe(false);

    for (const phase of PHASES) {
      const trace = cascadeTrace(phase);
      expect(applyVisualFixtureTrace(dataset, trace, SCENARIO)).toBe(false);
      const label = `rage-cascade.${phase}`;
      expect(matchVisualFixtureSemanticCheckpoint(
        SCENARIO,
        "1",
        label,
        { type: "presentation-trace", trace } as AppPresentationCheckpoint,
      )).toBe(label);
      expect(validatePass47SemanticCheckpoint(dataset, SCENARIO, label)).toBeNull();
    }

    expect(dataset).toMatchObject({
      fixtureStage: "rage-cascade.complete",
      fixtureRageCascadePhase: "complete",
      fixtureRageCascadeSourceCell: "0:1",
      fixtureRageCascadeTransformCells: "1:1,2:1",
      fixtureRageCascadeSourceCount: "1",
      fixtureRageCascadeTransformCount: "2",
      fixtureRageCascadeTriggered: "true",
      fixtureRageCascadeGuaranteed: "false",
      fixtureRageCascadeLevel: "1",
      fixtureRageCascadeTotal: "0",
      fixtureRageCascadeTraceHistory:
        "started,exploding,placed,pound,activation,source-hidden,complete",
      fixtureRageCascadeTraversalHistory: "8,7,6,5,4,3,2,1,0",
      fixtureRageCascadeTraversalCount: "9",
      fixtureRageCascadeShakeHistory: "respin,pound",
      fixtureRageCascadeShakeAuthoredHistory: "respin:400,pound:1930",
      fixtureRageCascadeShakeCount: "2",
      fixtureRageCascadeActivationAttempted: "3",
      fixtureRageCascadeActivationPlayed: "3",
      fixtureRageCascadeHidden: "true",
      fixtureRageCascadeStartedCount: "1",
      fixtureRageCascadeExplodingCount: "1",
      fixtureRageCascadePlacedCount: "1",
      fixtureRageCascadePoundCount: "1",
      fixtureRageCascadeActivationCount: "1",
      fixtureRageCascadeSourceHiddenCount: "1",
      fixtureRageCascadeCompleteCount: "1",
      fixtureRageCascadeEventHistory: "surge.collected,rage.transformed",
      fixtureRageCascadeEventCount: "2",
      fixtureRageCascadeVisualStartedCount: "1",
      fixtureTotalWinMinor: "1000",
      fixtureBalanceMinor: "100900",
    });

    expect(feature(dataset, WHEEL_STARTED)).toBe(false);
    expect(feature(dataset, WHEEL_AWARDED)).toBe(false);
    expect(applyPass47PresentationMilestone(
      dataset,
      SCENARIO,
      "wheel.popup-input-ready",
    )).toBe(false);
    expect(applyVisualFixtureTrace(
      dataset,
      { type: "round.complete", sequence: 1 },
      SCENARIO,
    )).toBe(false);
    expect(dataset.fixtureRageCascadeEventHistory)
      .toBe("surge.collected,rage.transformed,wheel.started,wheel.awarded");
    expect(dataset.fixtureRageCascadeEventCount).toBe("4");
    expect(dataset.fixtureRageCascadeWheelMilestones).toBe("wheel.popup-input-ready");
    expect(dataset.fixtureRageCascadeViolation).toBeUndefined();
    expect(dataset.fixtureTraceViolation).toBeUndefined();
  });

  it("fails closed on duplicate, missing, out-of-order, malformed or partial phases", () => {
    const duplicate: VisualFixtureDataset = {};
    readyForCascade(duplicate);
    expect(applyVisualFixtureTrace(duplicate, cascadeTrace("started"), SCENARIO)).toBe(false);
    expect(applyVisualFixtureTrace(duplicate, cascadeTrace("started"), SCENARIO)).toBe(true);
    expect(duplicate.fixtureRageCascadeViolation).toBe("rage-cascade-started-order");

    const missing: VisualFixtureDataset = {};
    readyForCascade(missing);
    expect(applyVisualFixtureTrace(missing, cascadeTrace("started"), SCENARIO)).toBe(false);
    expect(applyVisualFixtureTrace(missing, cascadeTrace("placed"), SCENARIO)).toBe(true);
    expect(missing.fixtureRageCascadeViolation).toBe("rage-cascade-placed-order");

    const reversed: VisualFixtureDataset = {};
    readyForCascade(reversed);
    expect(applyVisualFixtureTrace(reversed, cascadeTrace("exploding"), SCENARIO)).toBe(true);
    expect(reversed.fixtureRageCascadeViolation).toBe("rage-cascade-exploding-order");

    const wrongAddress: VisualFixtureDataset = {};
    readyForCascade(wrongAddress);
    expect(applyVisualFixtureTrace(wrongAddress, cascadeTrace("started"), SCENARIO)).toBe(false);
    expect(applyVisualFixtureTrace(wrongAddress, cascadeTrace("exploding", {
      transformedCells: [{ reel: 1, row: 1 }, { reel: 2, row: 2 }],
    }), SCENARIO)).toBe(true);
    expect(wrongAddress.fixtureRageCascadeViolation).toBe("rage-cascade-trace-contract");

    const partial: VisualFixtureDataset = {};
    readyForCascade(partial);
    for (const phase of ["started", "exploding", "placed", "pound"] as const) {
      expect(applyVisualFixtureTrace(partial, cascadeTrace(phase), SCENARIO)).toBe(false);
    }
    expect(applyVisualFixtureTrace(partial, cascadeTrace("activation", {
      activationPlayed: 2,
    }), SCENARIO)).toBe(true);
    expect(partial.fixtureRageCascadeViolation).toBe("rage-cascade-trace-contract");

    const missingVisual: VisualFixtureDataset = {};
    readyForCascade(missingVisual);
    expect(applyPass47VisualTelemetryEvent(
      missingVisual,
      SCENARIO,
      telemetry("rage.cascade"),
    )).toBe(false);
    expect(applyVisualFixtureTrace(
      missingVisual,
      cascadeTrace("started"),
      SCENARIO,
    )).toBe(false);
    missingVisual.fixtureVisualFailureCount = "1";
    missingVisual.fixtureVisualMissingRequired = "symbol.rage";
    expect(validatePass47SemanticCheckpoint(
      missingVisual,
      SCENARIO,
      "rage-cascade.started",
    )).toBe("rage-cascade-checkpoint-visual-assets");

    const duplicatedTraversal: VisualFixtureDataset = {};
    readyForCascade(duplicatedTraversal);
    expect(applyVisualFixtureTrace(
      duplicatedTraversal,
      cascadeTrace("started"),
      SCENARIO,
    )).toBe(false);
    const shuffledCells = (cascadeTrace("exploding") as unknown as {
      shuffledCells: Readonly<Record<string, unknown>>[];
    }).shuffledCells.map((cell) => ({ ...cell }));
    shuffledCells[1] = { ...shuffledCells[1], cellIndex: 8, address: { reel: 2, row: 2 } };
    expect(applyVisualFixtureTrace(duplicatedTraversal, cascadeTrace("exploding", {
      shuffledCells,
    }), SCENARIO)).toBe(true);
    expect(duplicatedTraversal.fixtureRageCascadeViolation).toBe("rage-cascade-trace-contract");
  });

  it("rejects wrong feature addresses, early Wheel and unexpected collect/tower paths", () => {
    const wrongEvent: VisualFixtureDataset = {};
    accepted(wrongEvent);
    expect(feature(wrongEvent, {
      ...SOURCE_EVENT,
      cells: [{ reel: 1, row: 1 }],
    })).toBe(true);
    expect(wrongEvent.fixtureRageCascadeViolation).toBe("rage-cascade-source-contract");

    const earlyWheel: VisualFixtureDataset = {};
    readyForCascade(earlyWheel);
    expect(feature(earlyWheel, WHEEL_STARTED)).toBe(true);
    expect(earlyWheel.fixtureRageCascadeViolation).toBe("rage-cascade-wheel-before-complete");

    const earlyMilestone: VisualFixtureDataset = {};
    readyForCascade(earlyMilestone);
    expect(applyPass47PresentationMilestone(
      earlyMilestone,
      SCENARIO,
      "wheel.spin-start",
    )).toBe(true);
    expect(earlyMilestone.fixtureRageCascadeViolation)
      .toBe("rage-cascade-wheel-before-complete");

    const earlyTelemetry: VisualFixtureDataset = {};
    readyForCascade(earlyTelemetry);
    expect(applyPass47VisualTelemetryEvent(
      earlyTelemetry,
      SCENARIO,
      telemetry("wheel.popup"),
    )).toBe(true);
    expect(earlyTelemetry.fixtureRageCascadeViolation)
      .toBe("rage-cascade-wheel-before-complete");

    const collectTelemetry: VisualFixtureDataset = {};
    readyForCascade(collectTelemetry);
    expect(applyPass47VisualTelemetryEvent(
      collectTelemetry,
      SCENARIO,
      telemetry("rage.collect"),
    )).toBe(true);
    expect(collectTelemetry.fixtureRageCascadeViolation)
      .toBe("rage-cascade-unexpected-collect-or-tower");

    const towerTrace: VisualFixtureDataset = {};
    readyForCascade(towerTrace);
    expect(applyVisualFixtureTrace(towerTrace, {
      type: "rage-collect.absorbing",
      sequence: 1,
    } as unknown as AppPresentationTrace, SCENARIO)).toBe(true);
    expect(towerTrace.fixtureRageCascadeViolation)
      .toBe("rage-cascade-unexpected-collect-or-tower");
  });

  it("allow-lists all seven holds only for the exact capture route and exact traces", () => {
    for (const phase of PHASES) {
      const label = `rage-cascade.${phase}`;
      const trace = cascadeTrace(phase);
      expect(resolveVisualFixtureSemanticCheckpoint(SCENARIO, "1", label)).toBe(label);
      expect(resolveVisualFixtureSemanticCheckpoint(SCENARIO, null, label)).toBeNull();
      expect(resolveVisualFixtureSemanticCheckpoint(SCENARIO, "0", label)).toBeNull();
      expect(resolveVisualFixtureSemanticCheckpoint("base-two-rage-no-wheel", "1", label))
        .toBeNull();
      expect(matchVisualFixtureSemanticCheckpoint(
        SCENARIO,
        "1",
        label,
        { type: "presentation-trace", trace } as AppPresentationCheckpoint,
      )).toBe(label);
      expect(matchVisualFixtureSemanticCheckpoint(
        SCENARIO,
        "1",
        label,
        {
          type: "presentation-trace",
          trace: cascadeTrace(phase, { sequence: 2 }),
        } as AppPresentationCheckpoint,
      )).toBeNull();
    }
    expect(resolveVisualFixtureSemanticCheckpoint(
      SCENARIO,
      "1",
      "rage-cascade.not-real",
    )).toBeNull();
  });

  it("releases an exact capture hold without creating a non-capture checkpoint", async () => {
    const label = resolveVisualFixtureSemanticCheckpoint(
      SCENARIO,
      "1",
      "rage-cascade.exploding",
    );
    expect(label).toBe("rage-cascade.exploding");
    expect(resolveVisualFixtureSemanticCheckpoint(
      SCENARIO,
      null,
      "rage-cascade.exploding",
    )).toBeNull();

    const target = new EventTarget();
    const dataset: VisualFixtureDataset = {};
    const hold = createVisualFixtureCheckpointHold(target, dataset, label!, 60_000);
    expect(dataset.fixtureCheckpoint).toBe("rage-cascade.exploding");
    target.dispatchEvent(new Event("visual-fixture-release"));
    await hold.promise;
    expect(dataset.fixtureCheckpoint).toBeUndefined();
  });

  it("keeps Pass47-specific guards inert for Pass44, Pass45 and Pass46", () => {
    const dataset: VisualFixtureDataset = {};
    for (const scenario of [
      "base-single-rage-no-wheel",
      "base-three-rage-wheel-entry",
      "base-two-rage-no-wheel",
    ]) {
      expect(applyPass47VisualTelemetryEvent(
        dataset,
        scenario,
        telemetry("rage.collect"),
      )).toBe(false);
      expect(applyPass47PresentationMilestone(dataset, scenario, "wheel.spin-start"))
        .toBe(false);
      expect(validatePass47SemanticCheckpoint(dataset, scenario, "rage-cascade.started"))
        .toBeNull();
    }
    expect(dataset.fixtureRageCascadeViolation).toBeUndefined();
  });
});
