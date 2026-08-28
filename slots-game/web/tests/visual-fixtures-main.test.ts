import { describe, expect, it, vi } from "vitest";
import {
  VisualTelemetryReporter,
  type VisualTelemetryEvent,
} from "../src/renderer/VisualTelemetry";
import type {
  AppPresentationCheckpoint,
  AppPresentationTrace,
  AppSemanticPresentationState,
} from "../src/app/AppController";
import fixtureMain from "../src/testing/visualFixturesMain.ts?raw";
import {
  applyNormalWinContinueControlClick,
  applyVisualFixtureFeatureEvent,
  applyVisualFixturePresentationBranch,
  applyVisualFixtureTelemetryEvent,
  applyVisualFixtureTrace,
  clearVisualFixtureCompletion,
  clearVisualFixtureFeatureEventProjection,
  clearVisualFixturePresentationBranches,
  clearVisualFixtureTrace,
  clearVisualFixtureVault,
  createVisualFixtureCheckpointHold,
  createVisualFixtureFeatureEventProjection,
  createVisualFixtureTelemetryProjectionState,
  isCapSummaryInputCheckpointCapture,
  isFreeSpinsSummaryInputCheckpointHold,
  isNoSummaryTerminalCheckpointCapture,
  isNormalWinContinueClickTrigger,
  isVisualFixtureCaptureClockPastTargetRejection,
  isPass45ForbiddenPresentationMilestone,
  isPass45ForbiddenVisualTelemetryEvent,
  isVisualFixtureCheckpointCapture,
  isWinEffectsMatrixTraceCheckpoint,
  matchVisualFixtureSemanticCheckpoint,
  resolveVisualFixtureSemanticCheckpoint,
  projectVisualFixtureFeatureEvent,
  publishVisualFixtureFeatureEventProjection,
  shouldProjectVisualFixtureTelemetryEvent,
  validatePass45SemanticCheckpoint,
  VISUAL_FIXTURE_RELEASE_KEY,
  type VisualFixtureDataset,
  VISUAL_FIXTURE_EVENT_HISTORY_LIMIT,
} from "../src/testing/visualFixtureObservation";

describe("visual fixture entry source contract", () => {
  it("keeps the allow-list in front of controller construction", () => {
    expect(fixtureMain.indexOf("isVisualFixtureScenario(scenario)"))
      .toBeLessThan(fixtureMain.indexOf("await AppController.create"));
    expect(fixtureMain).toContain('body.dataset.fixtureStatus = "booting"');
    expect(fixtureMain).toContain('body.dataset.fixtureStatus = "failed"');
    expect(fixtureMain).toContain("body.dataset.fixtureStartupError = error instanceof Error");
  });

  it("bypasses preview through dependency injection without mutating player storage", () => {
    expect(fixtureMain).toContain("skipFeaturePreview: true");
    expect(fixtureMain).toContain("characterCollectRandomSource");
    expect(fixtureMain).toContain('scenario === "base-single-rage-no-wheel"');
    expect(fixtureMain).toContain("? () => 0");
    expect(fixtureMain).not.toContain("localStorage");
    expect(fixtureMain).not.toContain("sessionStorage");
    expect(fixtureMain).not.toContain("wheelPresentationTimelineScale");
  });

  it("derives ready and failure from controller lifecycle callbacks", () => {
    expect(fixtureMain).toContain("onLaunchPhase");
    expect(fixtureMain).toContain('phase === "ready"');
    expect(fixtureMain).toContain('phase === "failed"');
    expect(fixtureMain).toContain("onRoundPresentationState");
    expect(fixtureMain).toContain('state === "failed"');
    expect(fixtureMain).toContain('body.dataset.fixtureRoundState = "idle"');
    expect(fixtureMain).not.toMatch(/app\.start\(\);\s*body\.dataset\.fixtureStatus = "ready"/);
  });

  it("conditions only the exact Pass45 and Pass48 captures without changing production spin", () => {
    expect(fixtureMain).toContain('scenario === "base-three-rage-wheel-entry"');
    expect(fixtureMain).toContain('"base-rage-level-two-persistent-aura"');
    expect(fixtureMain).toContain('capture === "1"');
    expect(fixtureMain).toContain("isPass48RageAuraCapture(scenario, capture)");
    expect(fixtureMain).toContain("app.prepareNeutralCharacterCapture()");
    expect(fixtureMain).toContain("!launchReady");
    expect(fixtureMain).toContain('? "ready" : "conditioning"');
    expect(fixtureMain).toContain('body.dataset.fixtureCharacterCaptureReady = "true"');
    expect(fixtureMain).toContain('prepareSpinMessageCapture("The Ape unlocks the Vault Bonus!")');
    expect(fixtureMain).toContain('body.dataset.fixtureSpinMessageReady = "true"');
    expect(fixtureMain).toContain("window.clearInterval(characterCaptureTimer)");
  });

  it("conditions the exact Pass46 capture with a deterministic collect cosmetic, spin copy, and 60s hold", () => {
    const spinMessageStart = fixtureMain.indexOf("const requiresSpinMessageCapture");
    const spinMessageEnd = fixtureMain.indexOf("let characterCaptureReady", spinMessageStart);
    const spinMessageGuard = fixtureMain.slice(spinMessageStart, spinMessageEnd);
    expect(spinMessageGuard).toContain('capture === "1"');
    expect(spinMessageGuard).toContain('scenario === "base-two-rage-no-wheel"');
    expect(fixtureMain).toContain('prepareSpinMessageCapture("The Ape unlocks the Vault Bonus!")');

    const collectRandomStart = fixtureMain.indexOf("characterCollectRandomSource:");
    const collectRandomEnd = fixtureMain.indexOf("}, {", collectRandomStart);
    const collectRandomGuard = fixtureMain.slice(collectRandomStart, collectRandomEnd);
    expect(collectRandomGuard).toContain('scenario === "base-two-rage-no-wheel"');
    expect(collectRandomGuard).toContain("? () => 0");

    const checkpointHoldStart = fixtureMain.indexOf("const hold = createVisualFixtureCheckpointHold");
    const checkpointHoldEnd = fixtureMain.indexOf("return hold.promise", checkpointHoldStart);
    const checkpointHoldGuard = fixtureMain.slice(checkpointHoldStart, checkpointHoldEnd);
    expect(checkpointHoldGuard).toContain('scenario === "base-two-rage-no-wheel"');
    expect(checkpointHoldGuard).toContain("? 60_000");
  });

  it("publishes round and stable milestone seams", () => {
    expect(fixtureMain).toContain("body.dataset.fixtureRoundState = state");
    expect(fixtureMain).toContain("body.dataset.fixtureMilestone = milestone");
    expect(fixtureMain).toContain("presentationMilestones.push(milestone)");
    expect(fixtureMain).toContain("body.dataset.fixtureMilestones = presentationMilestones.join");
    expect(fixtureMain).toContain("body.dataset.fixtureMilestoneCount = String");
    expect(fixtureMain).toContain("delete body.dataset.fixtureMilestone");
    expect(fixtureMain).toContain("delete body.dataset.fixtureMilestones");
    expect(fixtureMain).toContain("delete body.dataset.fixtureMilestoneCount");
    expect(fixtureMain).toContain("onPresentationBranch");
    expect(fixtureMain).toContain("applyVisualFixturePresentationBranch(body.dataset, branch)");
  });

  it("keeps actual feature-event history durable, bounded, and independent from current", () => {
    const wheel = { type: "wheel.started" as const };
    const vault = {
      type: "vault.upgraded" as const,
      reel: 1,
      row: 2,
      fromMultiplier: 2,
      toMultiplier: 3,
      prize: "x3",
      step: 1,
    };
    const initial = createVisualFixtureFeatureEventProjection();
    const first = projectVisualFixtureFeatureEvent(initial, wheel.type, wheel);
    const second = first && projectVisualFixtureFeatureEvent(first, vault.type, vault);
    const cleared = second && projectVisualFixtureFeatureEvent(second, null);

    expect(first).toMatchObject({ event: "wheel.started", eventCount: 1 });
    expect(second).toMatchObject({ event: "vault.upgraded", eventCount: 2 });
    expect(cleared).toEqual({
      event: null,
      events: ["wheel.started", "vault.upgraded"],
      eventCount: 2,
    });

    const dataset: VisualFixtureDataset = {};
    publishVisualFixtureFeatureEventProjection(dataset, cleared!);
    expect(dataset).toMatchObject({
      fixtureEvents: "wheel.started,vault.upgraded",
      fixtureEventCount: "2",
    });
    expect(dataset.fixtureEvent).toBeUndefined();
    clearVisualFixtureFeatureEventProjection(dataset);
    expect(dataset).toEqual({});

    const full = Object.freeze({
      event: "wheel.started" as const,
      events: Object.freeze(Array.from(
        { length: VISUAL_FIXTURE_EVENT_HISTORY_LIMIT },
        () => "wheel.started" as const,
      )),
      eventCount: VISUAL_FIXTURE_EVENT_HISTORY_LIMIT,
    });
    expect(projectVisualFixtureFeatureEvent(full, vault.type, vault)).toBeNull();
    expect(projectVisualFixtureFeatureEvent({ ...full, eventCount: 1 }, null)).toBeNull();
    expect(projectVisualFixtureFeatureEvent(initial, wheel.type, null)).toBeNull();
    expect(projectVisualFixtureFeatureEvent({
      event: null,
      events: null,
      eventCount: 0,
    } as unknown as Readonly<typeof initial>, null)).toBeNull();
  });

  it("queues one real primary-control Continue click after the merge-start callback", () => {
    expect(fixtureMain).toContain("isNormalWinContinueClickTrigger");
    expect(fixtureMain).toContain("queueMicrotask(() =>");
    expect(fixtureMain).toContain("normalWinContinueClickQueued = true");
    expect(fixtureMain).toContain("root.querySelector<HTMLButtonElement>('[data-role=\"spin\"]')");
    expect(fixtureMain).toContain("spin?.click()");
    expect(fixtureMain).toContain("applyNormalWinContinueControlClick");
    expect(fixtureMain).not.toContain("requestFastStop(");
  });

  it("locks failures from the real toast and browser error surfaces", () => {
    expect(fixtureMain).toContain('[data-role="toast"][data-visible="true"]');
    expect(fixtureMain).toContain('attributeFilter: ["data-visible"]');
    expect(fixtureMain).toContain('window.addEventListener("error", handleWindowError, true)');
    expect(fixtureMain).toContain('window.addEventListener("unhandledrejection", handleUnhandledRejection)');
    expect(fixtureMain).toContain("console.error = fixtureConsoleError");
    expect(fixtureMain).toContain("failureLocked = true");
    const rejectionHandlerStart = fixtureMain.indexOf("const handleUnhandledRejection");
    const rejectionHandlerEnd = fixtureMain.indexOf(
      "window.addEventListener(\"error\"",
      rejectionHandlerStart,
    );
    const rejectionHandler = fixtureMain.slice(rejectionHandlerStart, rejectionHandlerEnd);
    expect(rejectionHandler).toContain('fixtureCaptureClockGuard === "active"');
    expect(rejectionHandler).toContain(
      "isVisualFixtureCaptureClockPastTargetRejection(event.reason)",
    );
    expect(rejectionHandler).toContain("fail()");
    expect(rejectionHandler).not.toContain("preventDefault");
  });

  it("defers only the exact Playwright capture-clock past-target rejection to the browser gate", () => {
    const firefoxClockError = new Error("Cannot fast-forward to the past");
    firefoxClockError.stack = [
      "_innerFastForwardTo@debugger eval code:202:13",
      "pauseAt@debugger eval code:133:16",
      "async*@debugger eval code line 311 > eval:1:33",
    ].join("\n");
    expect(isVisualFixtureCaptureClockPastTargetRejection(firefoxClockError)).toBe(true);

    const applicationError = new Error("Cannot fast-forward to the past");
    expect(isVisualFixtureCaptureClockPastTargetRejection(applicationError)).toBe(false);
    const applicationStack = new Error("Cannot fast-forward to the past");
    applicationStack.stack = [
      "_innerFastForwardTo@app.js:1:1",
      "pauseAt@app.js:2:2",
    ].join("\n");
    expect(isVisualFixtureCaptureClockPastTargetRejection(applicationStack)).toBe(false);
    const reversedClockStack = new Error("Cannot fast-forward to the past");
    reversedClockStack.stack = [
      "pauseAt@debugger eval code:133:16",
      "_innerFastForwardTo@debugger eval code:202:13",
    ].join("\n");
    expect(isVisualFixtureCaptureClockPastTargetRejection(reversedClockStack)).toBe(false);
    const blankLineClockStack = new Error("Cannot fast-forward to the past");
    blankLineClockStack.stack = [
      "_innerFastForwardTo@debugger eval code:202:13",
      "  ",
      "pauseAt@debugger eval code:133:16",
    ].join("\n");
    expect(isVisualFixtureCaptureClockPastTargetRejection(blankLineClockStack)).toBe(false);
    const sourceSuffixClockStack = new Error("Cannot fast-forward to the past");
    sourceSuffixClockStack.stack = [
      "_innerFastForwardTo@debugger eval codeevil:202:13",
      "pauseAt@debugger eval codeevil:133:16",
    ].join("\n");
    expect(isVisualFixtureCaptureClockPastTargetRejection(sourceSuffixClockStack)).toBe(false);
    const incompleteClockStack = new Error("Cannot fast-forward to the past");
    incompleteClockStack.stack = "_innerFastForwardTo@debugger eval code:202:13";
    expect(isVisualFixtureCaptureClockPastTargetRejection(incompleteClockStack)).toBe(false);
    const wrongMessage = new Error("Cannot fast-forward to the past from application");
    wrongMessage.stack = firefoxClockError.stack;
    expect(isVisualFixtureCaptureClockPastTargetRejection(wrongMessage)).toBe(false);
    expect(isVisualFixtureCaptureClockPastTargetRejection(
      "Cannot fast-forward to the past",
    )).toBe(false);
  });

  it("projects strict visual telemetry without serializing result data", () => {
    expect(fixtureMain).toContain("onVisualTelemetry");
    expect(fixtureMain).toContain("fixtureVisualKind");
    expect(fixtureMain).toContain("fixtureVisualId");
    expect(fixtureMain).toContain("fixtureVisualOperation");
    expect(fixtureMain).toContain("fixtureVisualLoadedCount");
    expect(fixtureMain).toContain("fixtureVisualActiveCount");
    expect(fixtureMain).toContain("fixtureVisualFailureCount");
    expect(fixtureMain).toContain("fixtureVisualFailureCode");
    expect(fixtureMain).toContain("fixtureVisualFailureKind");
    expect(fixtureMain).toContain("fixtureVisualFailureId");
    expect(fixtureMain).toContain("fixtureVisualFailureOperation");
    expect(fixtureMain).toContain("fixtureVisualMissingRequired");
    expect(fixtureMain).toContain("VISUAL_TELEMETRY_ENTRY_REQUIRED_IDS");
    expect(fixtureMain).toContain('event.requirement === "conditional"');
    expect(fixtureMain).not.toContain("JSON.stringify(event)");
  });

  it("drains known visual operations only through cancelled teardown completions", () => {
    const dataset: Record<string, string | undefined> = {};
    const state = createVisualFixtureTelemetryProjectionState([]);
    const reporter = new VisualTelemetryReporter();
    let destroyed = false;
    let tearingDown = false;
    reporter.setListener((event: Readonly<VisualTelemetryEvent>) => {
      if (!shouldProjectVisualFixtureTelemetryEvent(destroyed, tearingDown, event)) return;
      applyVisualFixtureTelemetryEvent(dataset, state, event);
    });

    const known = reporter.start({
      id: "win.normal-record",
      requirement: "conditional",
      mode: "authored",
    });
    expect(state.activeVisualOperations.has(known.operationId)).toBe(true);

    destroyed = true;
    tearingDown = true;
    reporter.cancelAll();
    expect(state.activeVisualOperations.size).toBe(0);

    const ignoredNatural = reporter.start({
      id: "win.normal-record",
      requirement: "conditional",
      mode: "authored",
    });
    reporter.complete(ignoredNatural, "natural");
    expect(state.activeVisualOperations.size).toBe(0);

    const unknownCancellation = reporter.start({
      id: "win.normal-record",
      requirement: "conditional",
      mode: "authored",
    });
    reporter.complete(unknownCancellation, "cancelled");
    expect(state.activeVisualOperations.size).toBe(0);

    tearingDown = false;
    expect(shouldProjectVisualFixtureTelemetryEvent(destroyed, tearingDown, {
      schemaVersion: 1,
      kind: "complete",
      operationId: 999,
      id: "win.normal-record",
      requirement: "conditional",
      mode: "authored",
      outcome: "cancelled",
    })).toBe(false);
  });

  it("retains the first strict visual failure while later events keep counts live", () => {
    const dataset: Record<string, string | undefined> = {};
    const state = createVisualFixtureTelemetryProjectionState(["launch.intro"]);
    const reporter = new VisualTelemetryReporter();
    reporter.setListener((event: Readonly<VisualTelemetryEvent>) => {
      applyVisualFixtureTelemetryEvent(dataset, state, event);
    });

    reporter.loaded({
      id: "launch.intro",
      requirement: "required",
      mode: "authored",
    });
    const rage = reporter.start({
      id: "rage.cascade",
      requirement: "conditional",
      mode: "authored",
    });
    reporter.fail(rage, {
      stage: "animation",
      code: "missing-animation",
      fallback: "procedural",
    });
    const firstFailure = {
      kind: dataset.fixtureVisualKind,
      id: dataset.fixtureVisualId,
      operation: dataset.fixtureVisualOperation,
      code: dataset.fixtureVisualFailureCode,
    };

    const wheel = reporter.start({
      id: "wheel.spin",
      requirement: "conditional",
      mode: "authored",
    });
    expect(dataset.fixtureVisualActiveIds).toBe("wheel.spin");
    expect(dataset.fixtureVisualActiveOperations).toBe(`wheel.spin@${wheel.operationId}`);
    reporter.complete(wheel);
    reporter.failedToStart({
      id: "wheel.summary",
      requirement: "conditional",
      mode: "authored",
    }, {
      stage: "animation",
      code: "playback-failed",
      fallback: "none",
    });

    expect(firstFailure).toEqual({
      kind: "fail",
      id: "rage.cascade",
      operation: String(rage.operationId),
      code: "missing-animation",
    });
    expect({
      kind: dataset.fixtureVisualKind,
      id: dataset.fixtureVisualId,
      operation: dataset.fixtureVisualOperation,
      code: dataset.fixtureVisualFailureCode,
    }).toEqual(firstFailure);
    expect(dataset.fixtureVisualFailureKind).toBe("fail");
    expect(dataset.fixtureVisualFailureId).toBe("rage.cascade");
    expect(dataset.fixtureVisualFailureOperation).toBe(String(rage.operationId));
    expect(dataset.fixtureVisualFailureCount).toBe("2");
    expect(dataset.fixtureVisualLoadedCount).toBe("1");
    expect(dataset.fixtureVisualActiveCount).toBe("0");
    expect(dataset.fixtureVisualActiveIds).toBe("");
    expect(dataset.fixtureVisualActiveOperations).toBe("");
    expect(dataset.fixtureVisualMissingRequired).toBe("");
  });

  it("disconnects every fixture-owned hook before controller teardown", () => {
    const destroyStart = fixtureMain.indexOf("const destroy = (): void =>");
    const destroyBody = fixtureMain.slice(destroyStart, fixtureMain.indexOf("window.addEventListener", destroyStart));
    expect(destroyBody).toContain("destroyed = true");
    expect(destroyBody).toContain("checkpointHold?.release()");
    expect(destroyBody).toContain("toastObserver.disconnect()");
    expect(destroyBody).toContain('window.removeEventListener("error", handleWindowError, true)');
    expect(destroyBody).toContain('window.removeEventListener("unhandledrejection", handleUnhandledRejection)');
    expect(destroyBody).toContain("console.error = originalConsoleError");
    expect(destroyBody).toContain("clearVisualFixtureCompletion(body.dataset)");
    expect(destroyBody).toContain("clearVisualFixturePresentationBranches(body.dataset)");
    expect(destroyBody).toContain("clearVisualFixtureTrace(body.dataset)");
    expect(destroyBody).toContain("delete body.dataset.fixtureVisualKind");
    expect(destroyBody).toContain("delete body.dataset.fixtureVisualActiveIds");
    expect(destroyBody).toContain("delete body.dataset.fixtureVisualActiveOperations");
    expect(destroyBody).toContain("delete body.dataset.fixtureVisualMissingRequired");
    expect(destroyBody).not.toContain("retainedPayloadBytesAtDestroy");
    expect(destroyBody).not.toContain("activeVisualCountAtDestroy");
    expect(destroyBody).toContain("getDestroyedStreamingAssetDiagnostics()");
    expect(destroyBody).toContain("retainedPayloadBytesAfterDestroy");
    expect(destroyBody).toContain("activeVisualCountAfterDestroy");
    expect(destroyBody).toContain("activeVisualProjectionCountAfterDestroy");
    expect(destroyBody).toContain("fixtureDestroyAppDisposed");
    expect(destroyBody).toContain("fixtureDestroyCanvasCount");
    expect(destroyBody).toContain("fixtureDestroyRetainedPayloadBytes");
    expect(destroyBody).toContain("fixtureDestroySpinCount");
    expect(destroyBody).toContain("fixtureDestroyVisualActiveCount");
    expect(destroyBody).toContain("fixtureDestroyVisualProjectionActiveCount");
    expect(destroyBody).toContain("getDestroyedVisualTelemetryActiveCount()");
    expect(destroyBody).toContain("tearingDown = true");
    expect(destroyBody).toContain("tearingDown = false");
    expect(destroyBody.indexOf("destroyed = true"))
      .toBeLessThan(destroyBody.indexOf("activeApp?.destroy()"));
    expect(destroyBody.indexOf("activeApp?.destroy()"))
      .toBeLessThan(destroyBody.indexOf("getDestroyedStreamingAssetDiagnostics()"));
    expect(fixtureMain).toContain("if (destroyed) return");
  });

  it("fails closed when trace projection detects a stale owner completion", () => {
    expect(fixtureMain).toContain(
      "if (applyVisualFixtureTrace(body.dataset, trace, scenario))",
    );
  });

  it("enables the Vault checkpoint only for the exact allow-listed capture query", () => {
    expect(isVisualFixtureCheckpointCapture("king-upgrade-ladder", "1")).toBe(true);
    expect(isVisualFixtureCheckpointCapture("king-upgrade-ladder", "true")).toBe(false);
    expect(isVisualFixtureCheckpointCapture("king-upgrade-ladder", "01")).toBe(false);
    expect(isVisualFixtureCheckpointCapture("king-upgrade-ladder", "2")).toBe(false);
    expect(isVisualFixtureCheckpointCapture("king-flow", "1")).toBe(false);
    expect(fixtureMain).toContain("onPresentationCheckpoint");
    expect(fixtureMain).toContain("createVisualFixtureCheckpointHold");
  });

  it("allow-lists exact rare-state checkpoint queries and rejects near misses", () => {
    const accepted = [
      ["wheel-mini-flow", "wheel.popup-input-ready"],
      ["wheel-mini-flow", "wheel.input-ready"],
      ["wheel-mini-flow", "wheel.landing"],
      ["base-three-rage-wheel-entry", "wheel.popup-input-ready"],
      ["base-three-rage-wheel-entry", "wheel.input-ready"],
      ["king-flow", "wheel.landing"],
      ["kong-flow", "wheel.landing"],
      ["kong-flow", "kong.rows-8-settled"],
      ["kong-flow", "kong.retrigger-applied"],
      ["big-win", "big-win.show"],
      ["big-win", "big-win.level-up"],
      ["big-win", "big-win.count-end"],
      ["big-win", "big-win.hide-start"],
      ["normal-win-continue", "normal-win.hide-start"],
      ["base-wild-reveal-x100", "wild-reveal.pre"],
      ["base-wild-reveal-x100", "wild-reveal.complete"],
      ["base-single-rage-no-wheel", "rage-collect.started"],
      ["base-single-rage-no-wheel", "rage-collect.absorbing"],
      ["base-single-rage-no-wheel", "rage-collect.source-hidden"],
      ["base-single-rage-no-wheel", "rage-collect.complete"],
      ["base-two-rage-no-wheel", "rage-collect.started"],
      ["base-two-rage-no-wheel", "rage-collect.absorbing"],
      ["base-two-rage-no-wheel", "rage-collect.source-hidden"],
      ["base-two-rage-no-wheel", "rage-collect.complete"],
    ] as const;
    for (const [scenario, label] of accepted) {
      expect(resolveVisualFixtureSemanticCheckpoint(scenario, "1", label)).toBe(label);
    }

    expect(resolveVisualFixtureSemanticCheckpoint(
      "wheel-mini-flow",
      "true",
      "wheel.input-ready",
    )).toBeNull();
    expect(resolveVisualFixtureSemanticCheckpoint(
      "wheel-mini-flow",
      "1",
      "kong.rows-8-settled",
    )).toBeNull();
    expect(resolveVisualFixtureSemanticCheckpoint(
      "unknown",
      "1",
      "wheel.input-ready",
    )).toBeNull();
    expect(resolveVisualFixtureSemanticCheckpoint(
      "big-win",
      "1",
      "big-win.complete",
    )).toBeNull();
  });

  it("matches rare-state checkpoints only at their exact scenario sequence", () => {
    const semantic = (
      state: AppSemanticPresentationState,
      sequence: number,
    ): AppPresentationCheckpoint => ({ type: "semantic-state", state, sequence });

    expect(matchVisualFixtureSemanticCheckpoint(
      "wheel-mini-flow",
      "1",
      "wheel.landing",
      semantic("wheel.landing", 1),
    )).toBe("wheel.landing");
    expect(matchVisualFixtureSemanticCheckpoint(
      "wheel-mini-flow",
      "1",
      "wheel.landing",
      semantic("wheel.landing", 2),
    )).toBeNull();
    expect(matchVisualFixtureSemanticCheckpoint(
      "king-flow",
      "1",
      "wheel.landing",
      semantic("wheel.landing", 1),
    )).toBe("wheel.landing");
    expect(matchVisualFixtureSemanticCheckpoint(
      "kong-flow",
      "1",
      "wheel.landing",
      semantic("wheel.landing", 1),
    )).toBe("wheel.landing");
    expect(matchVisualFixtureSemanticCheckpoint(
      "kong-flow",
      "1",
      "wheel.landing",
      semantic("wheel.landing", 2),
    )).toBeNull();
    expect(matchVisualFixtureSemanticCheckpoint(
      "kong-flow",
      "1",
      "kong.rows-8-settled",
      semantic("kong.rows-8-settled", 4),
    )).toBe("kong.rows-8-settled");
    expect(matchVisualFixtureSemanticCheckpoint(
      "kong-flow",
      "1",
      "kong.retrigger-applied",
      semantic("kong.retrigger-applied", 5),
    )).toBe("kong.retrigger-applied");
    expect(matchVisualFixtureSemanticCheckpoint(
      "kong-flow",
      "1",
      "kong.retrigger-applied",
      semantic("kong.retrigger-applied", 4),
    )).toBeNull();

    const bigWinShow: AppPresentationCheckpoint = {
      type: "presentation-trace",
      trace: {
        type: "big-win.count-start",
        sequence: 1,
        atMs: 500,
        amountMinor: "0",
        tier: "bigwin",
      },
    };
    expect(matchVisualFixtureSemanticCheckpoint(
      "big-win",
      "1",
      "big-win.show",
      bigWinShow,
    )).toBe("big-win.show");
    expect(matchVisualFixtureSemanticCheckpoint(
      "big-win",
      "1",
      "big-win.hide-start",
      bigWinShow,
    )).toBeNull();
    expect(matchVisualFixtureSemanticCheckpoint(
      "win-effects-matrix",
      "1",
      "big-win.show",
      bigWinShow,
    )).toBeNull();
    const normalWinHide: AppPresentationCheckpoint = {
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
    };
    expect(matchVisualFixtureSemanticCheckpoint(
      "normal-win-continue",
      "1",
      "normal-win.hide-start",
      normalWinHide,
    )).toBe("normal-win.hide-start");
    expect(matchVisualFixtureSemanticCheckpoint(
      "normal-win-continue",
      "1",
      "normal-win.hide-start",
      {
        ...normalWinHide,
        trace: { ...normalWinHide.trace, index: 1 },
      } as AppPresentationCheckpoint,
    )).toBeNull();
    const wildReveal = (
      phase: "pre" | "complete",
      overrides: Record<string, unknown> = {},
    ): AppPresentationCheckpoint => ({
      type: "presentation-trace",
      trace: {
        type: `wild-reveal.${phase}`,
        sequence: 1,
        cells: [{ reel: 1, row: 1, multiplier: 100 }],
        outroMs: 1_000,
        ...overrides,
      },
    } as unknown as AppPresentationCheckpoint);
    expect(matchVisualFixtureSemanticCheckpoint(
      "base-wild-reveal-x100",
      "1",
      "wild-reveal.pre",
      wildReveal("pre"),
    )).toBe("wild-reveal.pre");
    expect(matchVisualFixtureSemanticCheckpoint(
      "base-wild-reveal-x100",
      "1",
      "wild-reveal.complete",
      wildReveal("complete"),
    )).toBe("wild-reveal.complete");
    expect(matchVisualFixtureSemanticCheckpoint(
      "base-wild-reveal-x100",
      "1",
      "wild-reveal.complete",
      wildReveal("pre"),
    )).toBeNull();
    expect(matchVisualFixtureSemanticCheckpoint(
      "base-wild-reveal-x100",
      "1",
      "wild-reveal.pre",
      wildReveal("pre", { sequence: 2 }),
    )).toBeNull();
    expect(matchVisualFixtureSemanticCheckpoint(
      "base-wild-reveal-x100",
      "1",
      "wild-reveal.pre",
      wildReveal("pre", { cells: [{ reel: 1, row: 0, multiplier: 100 }] }),
    )).toBeNull();
    expect(matchVisualFixtureSemanticCheckpoint(
      "base-wild-reveal-x100",
      "1",
      "wild-reveal.pre",
      wildReveal("pre", { cells: [{ reel: 1, row: 1, multiplier: 50 }] }),
    )).toBeNull();
    expect(matchVisualFixtureSemanticCheckpoint(
      "base-wild-reveal-x100",
      "1",
      "wild-reveal.pre",
      wildReveal("pre", { outroMs: 999 }),
    )).toBeNull();
    const rageCollect = (
      phase: "started" | "absorbing" | "source-hidden" | "complete",
      overrides: Record<string, unknown> = {},
    ): AppPresentationCheckpoint => {
      const expected = {
        started: { authoredAtMs: 0, activated: true, hidden: false, towerReactionStarted: false },
        absorbing: { authoredAtMs: 500, activated: true, hidden: false, towerReactionStarted: true },
        "source-hidden": {
          authoredAtMs: 1_016.7,
          activated: false,
          hidden: true,
          towerReactionStarted: true,
        },
        complete: { authoredAtMs: 1_200, activated: false, hidden: true, towerReactionStarted: true },
      }[phase];
      return {
        type: "presentation-trace",
        trace: {
          type: `rage-collect.${phase}`,
          sequence: 1,
          cells: [{ reel: 1, row: 0 }],
          count: 1,
          triggered: false,
          guaranteed: false,
          level: 1,
          total: 1,
          elapsedMs: expected.authoredAtMs,
          reducedMotion: false,
          bodyClip: "idle_breaker2",
          characterStarted: true,
          ...expected,
          ...overrides,
        },
      } as unknown as AppPresentationCheckpoint;
    };
    for (const phase of ["started", "absorbing", "source-hidden", "complete"] as const) {
      expect(matchVisualFixtureSemanticCheckpoint(
        "base-single-rage-no-wheel",
        "1",
        `rage-collect.${phase}`,
        rageCollect(phase),
      )).toBe(`rage-collect.${phase}`);
    }
    expect(matchVisualFixtureSemanticCheckpoint(
      "base-single-rage-no-wheel",
      "1",
      "rage-collect.absorbing",
      rageCollect("absorbing", { cells: [{ reel: 0, row: 0 }] }),
    )).toBeNull();
    expect(matchVisualFixtureSemanticCheckpoint(
      "base-single-rage-no-wheel",
      "1",
      "rage-collect.absorbing",
      rageCollect("absorbing", { bodyClip: "win" }),
    )).toBeNull();
    const twoRageCollect = (
      phase: "started" | "absorbing" | "source-hidden" | "complete",
      overrides: Record<string, unknown> = {},
    ): AppPresentationCheckpoint => {
      const expected = {
        started: { authoredAtMs: 0, activated: true, hidden: false, towerReactionStarted: false },
        absorbing: { authoredAtMs: 500, activated: true, hidden: false, towerReactionStarted: true },
        "source-hidden": {
          authoredAtMs: 1_016.7,
          activated: false,
          hidden: true,
          towerReactionStarted: true,
        },
        complete: { authoredAtMs: 1_200, activated: false, hidden: true, towerReactionStarted: true },
      }[phase];
      return {
        type: "presentation-trace",
        trace: {
          type: `rage-collect.${phase}`,
          sequence: 1,
          cells: [{ reel: 0, row: 1 }, { reel: 1, row: 1 }],
          count: 2,
          triggered: false,
          guaranteed: false,
          level: 1,
          total: 2,
          elapsedMs: expected.authoredAtMs,
          reducedMotion: false,
          bodyClip: "idle_breaker2",
          characterStarted: true,
          ...expected,
          ...overrides,
        },
      } as unknown as AppPresentationCheckpoint;
    };
    for (const phase of ["started", "absorbing", "source-hidden", "complete"] as const) {
      expect(matchVisualFixtureSemanticCheckpoint(
        "base-two-rage-no-wheel",
        "1",
        `rage-collect.${phase}`,
        twoRageCollect(phase),
      )).toBe(`rage-collect.${phase}`);
    }
    expect(matchVisualFixtureSemanticCheckpoint(
      "base-two-rage-no-wheel",
      "1",
      "rage-collect.absorbing",
      twoRageCollect("absorbing", {
        cells: [{ reel: 1, row: 1 }, { reel: 0, row: 1 }],
      }),
    )).toBeNull();
    expect(matchVisualFixtureSemanticCheckpoint(
      "base-two-rage-no-wheel",
      "1",
      "rage-collect.absorbing",
      twoRageCollect("absorbing", { cells: [{ reel: 0, row: 1 }], count: 1 }),
    )).toBeNull();
    expect(matchVisualFixtureSemanticCheckpoint(
      "base-two-rage-no-wheel",
      "1",
      "rage-collect.absorbing",
      twoRageCollect("absorbing", {
        cells: [{ reel: 0, row: 1 }, { reel: 0, row: 1 }],
      }),
    )).toBeNull();
    expect(fixtureMain).toContain("fixtureRequestedCheckpoint");
    expect(fixtureMain).toContain("matchVisualFixtureSemanticCheckpoint");
    expect(fixtureMain).toContain('scenario === "base-wild-reveal-x100"');
    expect(fixtureMain).toContain("? 60_000");
  });

  it("allow-lists only the two exact no-summary terminal-active checkpoints", () => {
    const zeroCompletion = {
      type: "free-spins-completed-active" as const,
      sequence: 9,
      mode: "EXPANSION" as const,
      awarded: 8,
      cumulativeWinMinor: "0",
    };
    const equalCompletion = { ...zeroCompletion, cumulativeWinMinor: "100" };

    expect(isNoSummaryTerminalCheckpointCapture(
      "summary-no-panel",
      "1",
      zeroCompletion,
    )).toBe(true);
    expect(isNoSummaryTerminalCheckpointCapture(
      "summary-no-panel-equal",
      "1",
      equalCompletion,
    )).toBe(true);

    expect(isNoSummaryTerminalCheckpointCapture(
      "summary-no-panel",
      "true",
      zeroCompletion,
    )).toBe(false);
    expect(isNoSummaryTerminalCheckpointCapture(
      "summary-no-panel-equal",
      "1",
      zeroCompletion,
    )).toBe(false);
    expect(isNoSummaryTerminalCheckpointCapture(
      "cap-summary",
      "1",
      equalCompletion,
    )).toBe(false);
    expect(isNoSummaryTerminalCheckpointCapture(
      "summary-no-panel",
      "1",
      { ...zeroCompletion, sequence: 8 },
    )).toBe(false);
    expect(isNoSummaryTerminalCheckpointCapture(
      "summary-no-panel",
      "1",
      { ...zeroCompletion, awarded: 9 },
    )).toBe(false);
    expect(isNoSummaryTerminalCheckpointCapture(
      "summary-no-panel",
      "1",
      { type: "vault-awards-complete", count: 3 },
    )).toBe(false);
    expect(fixtureMain).toContain('checkpoint.type === "free-spins-completed-active"');
    expect(fixtureMain).toContain("isNoSummaryTerminalCheckpointCapture");
  });

  it("allow-lists only the two exact cap-summary input-ready checkpoints", () => {
    const cap = {
      type: "bounded-gate-input-ready" as const,
      gate: "free-spin-cap" as const,
      sequence: 2,
    };
    const summary = {
      type: "bounded-gate-input-ready" as const,
      gate: "free-spins-summary" as const,
      sequence: 9,
    };
    expect(isCapSummaryInputCheckpointCapture("cap-summary", "1", cap)).toBe(true);
    expect(isCapSummaryInputCheckpointCapture("cap-summary", "1", summary)).toBe(true);

    expect(isCapSummaryInputCheckpointCapture("cap-summary", "true", cap)).toBe(false);
    expect(isCapSummaryInputCheckpointCapture("king-flow", "1", cap)).toBe(false);
    expect(isCapSummaryInputCheckpointCapture(
      "cap-summary",
      "1",
      { ...cap, sequence: 1 },
    )).toBe(false);
    expect(isCapSummaryInputCheckpointCapture(
      "cap-summary",
      "1",
      { ...summary, sequence: 8 },
    )).toBe(false);
    expect(isCapSummaryInputCheckpointCapture(
      "cap-summary",
      "1",
      { type: "vault-awards-complete", count: 1 },
    )).toBe(false);
    expect(fixtureMain).toContain('checkpoint.type === "bounded-gate-input-ready"');
    expect(fixtureMain).toContain("isCapSummaryInputCheckpointCapture");
    expect(fixtureMain).toContain('`${checkpoint.gate}.input-ready`');
  });

  it("holds only the three opted-in final free-spins summary gates", () => {
    const kingSummary = {
      type: "bounded-gate-input-ready" as const,
      gate: "free-spins-summary" as const,
      sequence: 9,
    };
    const kongSummary = { ...kingSummary, sequence: 10 };
    expect(isFreeSpinsSummaryInputCheckpointHold("king-flow", "1", kingSummary)).toBe(true);
    expect(isFreeSpinsSummaryInputCheckpointHold("kong-flow", "1", kongSummary)).toBe(true);
    expect(isFreeSpinsSummaryInputCheckpointHold("cap-summary", "1", kingSummary)).toBe(true);

    expect(isFreeSpinsSummaryInputCheckpointHold("king-flow", null, kingSummary)).toBe(false);
    expect(isFreeSpinsSummaryInputCheckpointHold("king-flow", "true", kingSummary)).toBe(false);
    expect(isFreeSpinsSummaryInputCheckpointHold("king-flow", "1", kongSummary)).toBe(false);
    expect(isFreeSpinsSummaryInputCheckpointHold("kong-flow", "1", kingSummary)).toBe(false);
    expect(isFreeSpinsSummaryInputCheckpointHold(
      "cap-summary",
      "1",
      { ...kingSummary, sequence: 8 },
    )).toBe(false);
    expect(isFreeSpinsSummaryInputCheckpointHold(
      "cap-summary",
      "1",
      { ...kingSummary, gate: "free-spin-cap" },
    )).toBe(false);
    expect(isFreeSpinsSummaryInputCheckpointHold("wheel-mini-flow", "1", kingSummary))
      .toBe(false);
    expect(isFreeSpinsSummaryInputCheckpointHold(
      "king-flow",
      "1",
      { type: "vault-awards-complete", count: 1 },
    )).toBe(false);

    expect(fixtureMain).toContain('searchParams.get("freeSpinsSummaryHold")');
    expect(fixtureMain).toContain("isFreeSpinsSummaryInputCheckpointHold");
    expect(fixtureMain).toContain('capture === "1" || freeSpinsSummaryHold === "1"');
    expect(fixtureMain).toContain("? 60_000");
  });

  it("mounts one invisible release control only for exact capture or summary-hold opt-in", () => {
    const allowListGuard = fixtureMain.indexOf("isVisualFixtureScenario(scenario)");
    const buttonCreation = fixtureMain.indexOf('document.createElement("button")');
    expect(buttonCreation).toBeGreaterThan(allowListGuard);
    expect(fixtureMain).toContain('if (capture === "1" || freeSpinsSummaryHold === "1")');
    expect(fixtureMain.match(/document\.createElement\("button"\)/g)).toHaveLength(1);
    expect(fixtureMain).toContain('button.dataset.role = "fixture-checkpoint-release"');
    expect(fixtureMain).toContain('button.setAttribute("aria-label", "Release visual fixture checkpoint")');
    expect(fixtureMain).toContain('position: "fixed"');
    expect(fixtureMain).toContain('width: "1px"');
    expect(fixtureMain).toContain('height: "1px"');
    expect(fixtureMain).toContain('opacity: "0"');
    expect(fixtureMain).toContain('pointerEvents: "auto"');
    expect(fixtureMain).toContain('zIndex: "2147483647"');
    expect(fixtureMain).toContain('button.addEventListener("click", releaseCheckpointFromButton)');
    expect(fixtureMain).toContain("checkpointHold?.release()");
    expect(fixtureMain).toContain('checkpointReleaseButton?.removeEventListener("click", releaseCheckpointFromButton)');
    expect(fixtureMain).toContain("checkpointReleaseButton?.remove()");
  });

  it("allow-lists only the requested win-effects trace checkpoints", () => {
    const recordTrace = (
      sequence: number,
      index: number,
      phase: "visible" | "show-complete" | "merge-start" | "merge-settled"
        | "hold-complete" | "hide-start" | "hidden",
    ) => ({
      type: `win-record.${phase}` as const,
      sequence,
      index,
      count: sequence === 5 ? 2 : 1,
      id: `record-${sequence}-${index}`,
      symbol: "TANK" as const,
      amountMinor: "100",
      multiplier: 1,
    });
    const selected = [
      ...[1, 2, 3, 4].map((sequence) => recordTrace(sequence, 0, "hold-complete")),
      recordTrace(5, 0, "show-complete"),
      recordTrace(5, 0, "merge-start"),
      recordTrace(5, 0, "merge-settled"),
      recordTrace(5, 0, "hold-complete"),
      recordTrace(5, 1, "show-complete"),
      recordTrace(5, 1, "hold-complete"),
      {
        type: "big-win.count-start" as const,
        sequence: 6,
        atMs: 500,
        amountMinor: "0",
        tier: "bigwin" as const,
      },
      recordTrace(6, 0, "visible"),
    ];
    for (const trace of selected) {
      expect(isWinEffectsMatrixTraceCheckpoint(
        "win-effects-matrix",
        "1",
        trace,
      )).toBe(true);
    }

    expect(isWinEffectsMatrixTraceCheckpoint(
      "win-effects-matrix",
      "1",
      recordTrace(6, 0, "merge-settled"),
    )).toBe(false);
    expect(isWinEffectsMatrixTraceCheckpoint(
      "win-effects-matrix",
      "1",
      recordTrace(5, 0, "visible"),
    )).toBe(false);
    expect(isWinEffectsMatrixTraceCheckpoint(
      "win-effects-matrix",
      "1",
      recordTrace(5, 0, "hide-start"),
    )).toBe(false);
    expect(isWinEffectsMatrixTraceCheckpoint(
      "win-effects-matrix",
      "1",
      recordTrace(5, 0, "hidden"),
    )).toBe(false);
    expect(isWinEffectsMatrixTraceCheckpoint(
      "win-effects-matrix",
      "1",
      recordTrace(5, 1, "visible"),
    )).toBe(false);
    expect(isWinEffectsMatrixTraceCheckpoint(
      "win-effects-matrix",
      "1",
      recordTrace(5, 1, "hidden"),
    )).toBe(false);
    expect(isWinEffectsMatrixTraceCheckpoint(
      "win-effects-matrix",
      "true",
      recordTrace(1, 0, "visible"),
    )).toBe(false);
    expect(isWinEffectsMatrixTraceCheckpoint(
      "big-win",
      "1",
      recordTrace(1, 0, "visible"),
    )).toBe(false);
  });
});

describe("visual fixture presentation projection", () => {
  it("projects the single-Rage miss lifecycle after logical round completion", () => {
    const scenario = "base-single-rage-no-wheel";
    const dataset: VisualFixtureDataset = {};
    const trace = (
      phase: "started" | "absorbing" | "source-hidden" | "complete",
      overrides: Record<string, unknown> = {},
    ): AppPresentationTrace => {
      const expected = {
        started: { authoredAtMs: 0, activated: true, hidden: false, towerReactionStarted: false },
        absorbing: { authoredAtMs: 500, activated: true, hidden: false, towerReactionStarted: true },
        "source-hidden": {
          authoredAtMs: 1_016.7,
          activated: false,
          hidden: true,
          towerReactionStarted: true,
        },
        complete: { authoredAtMs: 1_200, activated: false, hidden: true, towerReactionStarted: true },
      }[phase];
      return {
        type: `rage-collect.${phase}`,
        sequence: 1,
        cells: [{ reel: 1, row: 0 }],
        count: 1,
        triggered: false,
        guaranteed: false,
        level: 1,
        total: 1,
        elapsedMs: expected.authoredAtMs,
        reducedMotion: false,
        bodyClip: "idle_breaker2",
        characterStarted: true,
        ...expected,
        ...overrides,
      } as unknown as AppPresentationTrace;
    };

    expect(applyVisualFixtureTrace(dataset, {
      type: "result.accepted",
      sequence: 1,
      roundId: "round-base-single-rage-no-wheel",
      totalWinMinor: "0",
      balanceMinor: "99900",
      winCount: 0,
    }, scenario)).toBe(false);
    expect(dataset).toMatchObject({
      fixtureRageCollectStartedCount: "0",
      fixtureRageCollectAbsorbingCount: "0",
      fixtureRageCollectSourceHiddenCount: "0",
      fixtureRageCollectCompleteCount: "0",
      fixtureRageCollectTraceHistory: "",
    });

    expect(applyVisualFixtureTrace(dataset, trace("started"), scenario)).toBe(false);
    // 官方 1ms PPS 屏障之后，源任务会刻意由后台持有，因此逻辑回合可能先于
    // 后续像素完成。
    expect(applyVisualFixtureTrace(
      dataset,
      { type: "round.complete", sequence: 1 },
      scenario,
    )).toBe(false);
    expect(applyVisualFixtureTrace(dataset, trace("absorbing"), scenario)).toBe(false);
    expect(dataset).toMatchObject({
      fixtureStage: "rage-collect.absorbing",
      fixtureRageCollectPhase: "absorbing",
      fixtureRageCollectCell: "1:0",
      fixtureRageCollectCount: "1",
      fixtureRageCollectTriggered: "false",
      fixtureRageCollectGuaranteed: "false",
      fixtureRageCollectLevel: "1",
      fixtureRageCollectTotal: "1",
      fixtureRageCollectBodyClip: "idle_breaker2",
      fixtureRageCollectCharacterStarted: "true",
      fixtureRageCollectActivated: "true",
      fixtureRageCollectHidden: "false",
      fixtureRageCollectTowerStarted: "true",
      fixtureRageCollectAuthoredAtMs: "500",
      fixtureRageCollectTraceHistory: "started,absorbing",
    });
    expect(applyVisualFixtureTrace(dataset, trace("source-hidden"), scenario)).toBe(false);
    expect(applyVisualFixtureTrace(dataset, trace("complete"), scenario)).toBe(false);
    expect(dataset).toMatchObject({
      fixtureStage: "rage-collect.complete",
      fixtureRageCollectPhase: "complete",
      fixtureRageCollectActivated: "false",
      fixtureRageCollectHidden: "true",
      fixtureRageCollectTowerStarted: "true",
      fixtureRageCollectStartedCount: "1",
      fixtureRageCollectAbsorbingCount: "1",
      fixtureRageCollectSourceHiddenCount: "1",
      fixtureRageCollectCompleteCount: "1",
      fixtureRageCollectTraceHistory: "started,absorbing,source-hidden,complete",
    });
    expect(dataset.fixtureRageCollectViolation).toBeUndefined();
    expect(dataset.fixtureTraceViolation).toBeUndefined();
  });

  it("fails the single-Rage fixture on reversed, duplicate, or malformed phases", () => {
    const scenario = "base-single-rage-no-wheel";
    const accepted = (dataset: VisualFixtureDataset): void => {
      expect(applyVisualFixtureTrace(dataset, {
        type: "result.accepted",
        sequence: 1,
        roundId: "round-base-single-rage-no-wheel",
        totalWinMinor: "0",
        balanceMinor: "99900",
        winCount: 0,
      }, scenario)).toBe(false);
    };
    const trace = (
      phase: "started" | "absorbing",
      overrides: Record<string, unknown> = {},
    ): AppPresentationTrace => ({
      type: `rage-collect.${phase}`,
      sequence: 1,
      cells: [{ reel: 1, row: 0 }],
      count: 1,
      triggered: false,
      guaranteed: false,
      level: 1,
      total: 1,
      elapsedMs: phase === "started" ? 0 : 500,
      authoredAtMs: phase === "started" ? 0 : 500,
      reducedMotion: false,
      activated: true,
      hidden: false,
      towerReactionStarted: phase === "absorbing",
      bodyClip: "idle_breaker2",
      characterStarted: true,
      ...overrides,
    } as unknown as AppPresentationTrace);

    const reversed: VisualFixtureDataset = {};
    accepted(reversed);
    expect(applyVisualFixtureTrace(reversed, trace("absorbing"), scenario)).toBe(true);
    expect(reversed.fixtureRageCollectViolation).toBe("rage-collect-absorbing-order");

    const duplicate: VisualFixtureDataset = {};
    accepted(duplicate);
    expect(applyVisualFixtureTrace(duplicate, trace("started"), scenario)).toBe(false);
    expect(applyVisualFixtureTrace(duplicate, trace("started"), scenario)).toBe(true);
    expect(duplicate.fixtureRageCollectViolation).toBe("rage-collect-started-order");

    const malformed: VisualFixtureDataset = {};
    accepted(malformed);
    expect(applyVisualFixtureTrace(
      malformed,
      trace("started", { triggered: true }),
      scenario,
    )).toBe(true);
    expect(malformed.fixtureRageCollectViolation).toBe("rage-collect-trace-contract");
  });

  it("projects both Pass46 Rage sources through one strict collection lifecycle", () => {
    const scenario = "base-two-rage-no-wheel";
    const dataset: VisualFixtureDataset = {};
    const trace = (
      phase: "started" | "absorbing" | "source-hidden" | "complete",
      overrides: Record<string, unknown> = {},
    ): AppPresentationTrace => {
      const expected = {
        started: { authoredAtMs: 0, activated: true, hidden: false, towerReactionStarted: false },
        absorbing: { authoredAtMs: 500, activated: true, hidden: false, towerReactionStarted: true },
        "source-hidden": {
          authoredAtMs: 1_016.7,
          activated: false,
          hidden: true,
          towerReactionStarted: true,
        },
        complete: { authoredAtMs: 1_200, activated: false, hidden: true, towerReactionStarted: true },
      }[phase];
      return {
        type: `rage-collect.${phase}`,
        sequence: 1,
        cells: [{ reel: 0, row: 1 }, { reel: 1, row: 1 }],
        count: 2,
        triggered: false,
        guaranteed: false,
        level: 1,
        total: 2,
        elapsedMs: expected.authoredAtMs,
        reducedMotion: false,
        bodyClip: "idle_breaker2",
        characterStarted: true,
        ...expected,
        ...overrides,
      } as unknown as AppPresentationTrace;
    };

    expect(applyVisualFixtureTrace(dataset, {
      type: "result.accepted",
      sequence: 1,
      roundId: "round-base-two-rage-no-wheel",
      totalWinMinor: "0",
      balanceMinor: "99900",
      winCount: 0,
    }, scenario)).toBe(false);

    for (const phase of ["started", "absorbing", "source-hidden", "complete"] as const) {
      expect(applyVisualFixtureTrace(dataset, trace(phase), scenario)).toBe(false);
      expect(dataset.fixtureRageCollectPhase).toBe(phase);
      expect(dataset.fixtureRageCollectCell).toBe("0:1,1:1");
      expect(dataset.fixtureRageCollectCount).toBe("2");
      expect(dataset.fixtureRageCollectTotal).toBe("2");
    }

    expect(dataset).toMatchObject({
      fixtureStage: "rage-collect.complete",
      fixtureRageCollectTriggered: "false",
      fixtureRageCollectGuaranteed: "false",
      fixtureRageCollectLevel: "1",
      fixtureRageCollectBodyClip: "idle_breaker2",
      fixtureRageCollectCharacterStarted: "true",
      fixtureRageCollectActivated: "false",
      fixtureRageCollectHidden: "true",
      fixtureRageCollectTowerStarted: "true",
      fixtureRageCollectStartedCount: "1",
      fixtureRageCollectAbsorbingCount: "1",
      fixtureRageCollectSourceHiddenCount: "1",
      fixtureRageCollectCompleteCount: "1",
      fixtureRageCollectTraceHistory: "started,absorbing,source-hidden,complete",
    });
    expect(dataset.fixtureRageCollectViolation).toBeUndefined();
    expect(dataset.fixtureTraceViolation).toBeUndefined();
  });

  it("rejects reordered, single, duplicate, malformed, or out-of-order Pass46 collection input", () => {
    const scenario = "base-two-rage-no-wheel";
    const accepted = (dataset: VisualFixtureDataset): void => {
      expect(applyVisualFixtureTrace(dataset, {
        type: "result.accepted",
        sequence: 1,
        roundId: "round-base-two-rage-no-wheel",
        totalWinMinor: "0",
        balanceMinor: "99900",
        winCount: 0,
      }, scenario)).toBe(false);
    };
    const trace = (
      phase: "started" | "absorbing",
      overrides: Record<string, unknown> = {},
    ): AppPresentationTrace => ({
      type: `rage-collect.${phase}`,
      sequence: 1,
      cells: [{ reel: 0, row: 1 }, { reel: 1, row: 1 }],
      count: 2,
      triggered: false,
      guaranteed: false,
      level: 1,
      total: 2,
      elapsedMs: phase === "started" ? 0 : 500,
      authoredAtMs: phase === "started" ? 0 : 500,
      reducedMotion: false,
      activated: true,
      hidden: false,
      towerReactionStarted: phase === "absorbing",
      bodyClip: "idle_breaker2",
      characterStarted: true,
      ...overrides,
    } as unknown as AppPresentationTrace);

    const reordered: VisualFixtureDataset = {};
    accepted(reordered);
    expect(applyVisualFixtureTrace(reordered, trace("started", {
      cells: [{ reel: 1, row: 1 }, { reel: 0, row: 1 }],
    }), scenario)).toBe(true);
    expect(reordered.fixtureRageCollectViolation).toBe("rage-collect-trace-contract");

    const single: VisualFixtureDataset = {};
    accepted(single);
    expect(applyVisualFixtureTrace(single, trace("started", {
      cells: [{ reel: 0, row: 1 }],
      count: 1,
    }), scenario)).toBe(true);
    expect(single.fixtureRageCollectViolation).toBe("rage-collect-trace-contract");

    const duplicate: VisualFixtureDataset = {};
    accepted(duplicate);
    expect(applyVisualFixtureTrace(duplicate, trace("started", {
      cells: [{ reel: 0, row: 1 }, { reel: 0, row: 1 }],
    }), scenario)).toBe(true);
    expect(duplicate.fixtureRageCollectViolation).toBe("rage-collect-trace-contract");

    const malformed: VisualFixtureDataset = {};
    accepted(malformed);
    expect(applyVisualFixtureTrace(malformed, trace("started", {
      total: 1,
      triggered: true,
    }), scenario)).toBe(true);
    expect(malformed.fixtureRageCollectViolation).toBe("rage-collect-trace-contract");

    const outOfOrder: VisualFixtureDataset = {};
    accepted(outOfOrder);
    expect(applyVisualFixtureTrace(outOfOrder, trace("absorbing"), scenario)).toBe(true);
    expect(outOfOrder.fixtureRageCollectViolation).toBe("rage-collect-absorbing-order");
  });

  it("projects the exact Wild-x100 reveal boundaries in strict pre-to-complete order", () => {
    const scenario = "base-wild-reveal-x100";
    const dataset: VisualFixtureDataset = {};
    const trace = (
      phase: "pre" | "complete",
      overrides: Record<string, unknown> = {},
    ): AppPresentationTrace => ({
      type: `wild-reveal.${phase}`,
      sequence: 1,
      cells: [{ reel: 1, row: 1, multiplier: 100 }],
      outroMs: 1_000,
      ...overrides,
    } as unknown as AppPresentationTrace);

    expect(applyVisualFixtureTrace(dataset, {
      type: "result.accepted",
      sequence: 1,
      roundId: "round-base-wild-reveal-x100",
      totalWinMinor: "0",
      balanceMinor: "99900",
      winCount: 0,
    }, scenario)).toBe(false);
    expect(dataset).toMatchObject({
      fixtureWildRevealPreCount: "0",
      fixtureWildRevealCompleteCount: "0",
      fixtureWildRevealTraceHistory: "",
    });

    expect(applyVisualFixtureTrace(dataset, trace("pre"), scenario)).toBe(false);
    expect(dataset).toMatchObject({
      fixtureStage: "wild-reveal.pre",
      fixtureWildRevealPhase: "pre",
      fixtureWildRevealCell: "1:1",
      fixtureWildRevealMultiplier: "100",
      fixtureWildRevealOutroMs: "1000",
      fixtureWildRevealPreCount: "1",
      fixtureWildRevealCompleteCount: "0",
      fixtureWildRevealTraceHistory: "pre",
    });

    expect(applyVisualFixtureTrace(dataset, trace("complete"), scenario)).toBe(false);
    expect(dataset).toMatchObject({
      fixtureStage: "wild-reveal.complete",
      fixtureWildRevealPhase: "complete",
      fixtureWildRevealPreCount: "1",
      fixtureWildRevealCompleteCount: "1",
      fixtureWildRevealTraceHistory: "pre,complete",
    });
    expect(applyVisualFixtureTrace(
      dataset,
      { type: "round.complete", sequence: 1 },
      scenario,
    )).toBe(false);
    expect(dataset.fixtureWildRevealViolation).toBeUndefined();
    expect(dataset.fixtureTraceViolation).toBeUndefined();

    clearVisualFixtureTrace(dataset);
    expect(dataset).toEqual({});
  });

  it("fails the Wild-x100 fixture on reversed, duplicate, or malformed boundaries", () => {
    const scenario = "base-wild-reveal-x100";
    const accepted = (dataset: VisualFixtureDataset): void => {
      expect(applyVisualFixtureTrace(dataset, {
        type: "result.accepted",
        sequence: 1,
        roundId: "round-base-wild-reveal-x100",
        totalWinMinor: "0",
        balanceMinor: "99900",
        winCount: 0,
      }, scenario)).toBe(false);
    };
    const trace = (
      phase: "pre" | "complete",
      overrides: Record<string, unknown> = {},
    ): AppPresentationTrace => ({
      type: `wild-reveal.${phase}`,
      sequence: 1,
      cells: [{ reel: 1, row: 1, multiplier: 100 }],
      outroMs: 1_000,
      ...overrides,
    } as unknown as AppPresentationTrace);

    const reversed: VisualFixtureDataset = {};
    accepted(reversed);
    expect(applyVisualFixtureTrace(reversed, trace("complete"), scenario)).toBe(true);
    expect(reversed.fixtureWildRevealViolation).toBe("wild-reveal-complete-order");

    const duplicate: VisualFixtureDataset = {};
    accepted(duplicate);
    expect(applyVisualFixtureTrace(duplicate, trace("pre"), scenario)).toBe(false);
    expect(applyVisualFixtureTrace(duplicate, trace("pre"), scenario)).toBe(true);
    expect(duplicate.fixtureWildRevealViolation).toBe("wild-reveal-pre-order");

    const malformed: VisualFixtureDataset = {};
    accepted(malformed);
    expect(applyVisualFixtureTrace(malformed, trace("pre", {
      cells: [{ reel: 1, row: 1, multiplier: 50 }],
    }), scenario)).toBe(true);
    expect(malformed.fixtureWildRevealViolation).toBe("wild-reveal-trace-contract");

    const incomplete: VisualFixtureDataset = {};
    accepted(incomplete);
    expect(applyVisualFixtureTrace(
      incomplete,
      { type: "round.complete", sequence: 1 },
      scenario,
    )).toBe(true);
    expect(incomplete.fixtureWildRevealViolation).toBe("wild-reveal-incomplete");
  });

  it("proves one accepted DOM Continue, skips record 1, and separates logical done from visual hidden", () => {
    const scenario = "normal-win-continue";
    const dataset: VisualFixtureDataset = {};
    const resident = (
      phase: "active" | "hiding" | "hidden",
    ) => ({
      generation: 9,
      labelInstanceId: 71,
      framePoolInstanceId: 72,
      framePoolSize: 24,
      activeBoxCount: phase === "hidden" ? 0 : 4,
      activeOwnerCount: phase === "hidden" ? 0 : 1,
      pendingCleanupCount: phase === "hiding" ? 1 : 0,
      viewReused: false,
      handoffDelayMs: 0,
      staleHiddenCount: 0,
    });
    const recordTrace = (
      phase: "visible" | "show-complete" | "merge-start" | "hide-start" | "hidden",
      residentPhase: "active" | "hiding" | "hidden",
    ): AppPresentationTrace => ({
      type: `win-record.${phase}`,
      sequence: 1,
      index: 0,
      count: 2,
      id: "continue-prism-wild-x5-four-boxes",
      symbol: "PRISM",
      amountMinor: "500",
      multiplier: 5,
      resident: resident(residentPhase),
    });

    expect(applyVisualFixtureTrace(dataset, {
      type: "result.accepted",
      sequence: 1,
      roundId: "round-normal-win-continue",
      totalWinMinor: "800",
      balanceMinor: "100700",
      winCount: 2,
    }, scenario)).toBe(false);
    expect(dataset).toMatchObject({
      fixtureContinueClickCount: "0",
      fixtureContinueAcceptedCount: "0",
      fixtureContinueRecord1Seen: "false",
      fixtureContinueLogicalDoneCount: "0",
      fixtureContinueVisualHiddenCount: "0",
    });

    expect(applyVisualFixtureTrace(dataset, recordTrace("visible", "active"), scenario))
      .toBe(false);
    expect(applyVisualFixtureTrace(
      dataset,
      recordTrace("show-complete", "active"),
      scenario,
    )).toBe(false);
    const mergeStart = recordTrace("merge-start", "active");
    expect(isNormalWinContinueClickTrigger(scenario, "1", mergeStart)).toBe(true);
    expect(isNormalWinContinueClickTrigger(scenario, "true", mergeStart)).toBe(false);
    expect(applyVisualFixtureTrace(dataset, mergeStart, scenario)).toBe(false);
    expect(dataset.fixtureContinueTriggeredAt).toBe("1:0:merge-start");

    let realClickCount = 0;
    expect(applyNormalWinContinueControlClick(
      dataset,
      { mode: "continue", action: "fast-stop", disabled: false },
      () => {
        realClickCount += 1;
    // 真实处理器会同步发布 accepted，并可能发布更多嵌套演出轨迹。这些轨迹必须
    // 已经观察到第 1 次点击。
        expect(dataset.fixtureContinueClickCount).toBe("1");
        expect(applyVisualFixtureTrace(dataset, {
          type: "normal-win.continue-accepted",
          sequence: 1,
        }, scenario)).toBe(false);
        expect(applyVisualFixtureTrace(
          dataset,
          recordTrace("hide-start", "hiding"),
          scenario,
        )).toBe(false);
        return { mode: "waiting", action: "none", disabled: true };
      },
    )).toBe(false);
    expect(realClickCount).toBe(1);
    expect(dataset.fixtureContinueAcceptedCount).toBe("1");
    expect(dataset.fixtureContinueVisualHiddenCount).toBe("0");

    const logicalDone = {
      type: "normal-win.logical-done",
      sequence: 1,
    } as unknown as AppPresentationTrace;
    expect(applyVisualFixtureTrace(dataset, logicalDone, scenario)).toBe(false);
    expect(dataset).toMatchObject({
      fixtureContinueLogicalDoneCount: "1",
      fixtureContinueVisualHiddenCount: "0",
      fixtureContinueRecord1Seen: "false",
      fixtureResidentActiveBoxCount: "4",
      fixtureResidentActiveOwnerCount: "1",
      fixtureResidentPendingCleanupCount: "1",
    });

    expect(applyVisualFixtureTrace(
      dataset,
      { type: "round.complete", sequence: 1 },
      scenario,
    )).toBe(false);
    expect(applyVisualFixtureTrace(
      dataset,
      recordTrace("hidden", "hidden"),
      scenario,
    )).toBe(false);
    expect(dataset).toMatchObject({
      fixtureContinueClickCount: "1",
      fixtureContinueAcceptedCount: "1",
      fixtureContinueRecord1Seen: "false",
      fixtureContinueLogicalDoneCount: "1",
      fixtureContinueVisualHiddenCount: "1",
      fixtureResidentActiveBoxCount: "0",
      fixtureResidentActiveOwnerCount: "0",
      fixtureResidentPendingCleanupCount: "0",
    });
    expect(dataset.fixtureTraceViolation).toBeUndefined();
    expect(dataset.fixtureTraceHistory).toBe(
      "1:0:visible,1:0:show-complete,1:0:merge-start,1:0:hide-start,1:0:hidden",
    );
  });

  it("fails the Continue fixture on a rejected control transition or any record-1 trace", () => {
    const rejected: VisualFixtureDataset = {
      fixtureContinueTriggeredAt: "1:0:merge-start",
      fixtureContinueClickCount: "0",
      fixtureContinueAcceptedCount: "0",
    };
    let clickCount = 0;
    expect(applyNormalWinContinueControlClick(
      rejected,
      { mode: "continue", action: "fast-stop", disabled: false },
      () => {
        clickCount += 1;
        return { mode: "continue", action: "fast-stop", disabled: false };
      },
    )).toBe(true);
    expect(clickCount).toBe(1);
    expect(rejected).toMatchObject({
      fixtureContinueClickCount: "1",
      fixtureContinueAcceptedCount: "0",
      fixtureTraceViolation: "continue-control-contract",
    });

    const record1: VisualFixtureDataset = {};
    expect(applyVisualFixtureTrace(record1, {
      type: "result.accepted",
      sequence: 1,
      roundId: "round-normal-win-continue",
      totalWinMinor: "800",
      balanceMinor: "100700",
      winCount: 2,
    }, "normal-win-continue")).toBe(false);
    expect(applyVisualFixtureTrace(record1, {
      type: "win-record.visible",
      sequence: 1,
      index: 1,
      count: 2,
      id: "continue-orbit-plain-sentinel",
      symbol: "ORBIT",
      amountMinor: "300",
      multiplier: 1,
      resident: {
        generation: 10,
        labelInstanceId: 71,
        framePoolInstanceId: 72,
        framePoolSize: 24,
        activeBoxCount: 3,
        activeOwnerCount: 1,
        pendingCleanupCount: 0,
        viewReused: true,
        handoffDelayMs: 0,
        staleHiddenCount: 0,
      },
    }, "normal-win-continue")).toBe(true);
    expect(record1).toMatchObject({
      fixtureContinueRecord1Seen: "true",
      fixtureTraceViolation: "continue-record1-visible",
      fixtureTraceHistory: "1:1:visible:stale",
    });
  });

  it("projects trace state, resets record fields on acceptance, and counts completion", () => {
    const dataset: VisualFixtureDataset = {
      fixtureRecordId: "stale",
      fixtureRecordPhase: "hidden",
      fixtureBigWinMilestone: "complete",
    };

    applyVisualFixtureTrace(dataset, {
      type: "result.accepted",
      sequence: 7,
      roundId: "round-7",
      totalWinMinor: "200",
      balanceMinor: "100100",
      winCount: 2,
    });
    expect(dataset).toMatchObject({
      fixtureSequence: "7",
      fixtureStage: "result.accepted",
      fixtureTotalWinMinor: "200",
      fixtureBalanceMinor: "100100",
    });
    expect(dataset.fixtureRecordId).toBeUndefined();
    expect(dataset.fixtureRecordPhase).toBeUndefined();
    expect(dataset.fixtureBigWinMilestone).toBeUndefined();

    applyVisualFixtureTrace(dataset, {
      type: "counter.started",
      sequence: 7,
      totalWinMinor: "200",
      displayStartMinor: "0",
      displayTotalMinor: "200",
    });
    applyVisualFixtureTrace(dataset, {
      type: "win-record.merge-settled",
      sequence: 7,
      index: 1,
      count: 2,
      id: "record-b",
      symbol: "ORBIT",
      amountMinor: "120",
      multiplier: 2,
    });
    expect(dataset).toMatchObject({
      fixtureCounterState: "started",
      fixtureRecordIndex: "1",
      fixtureRecordCount: "2",
      fixtureRecordId: "record-b",
      fixtureRecordSymbol: "ORBIT",
      fixtureRecordPhase: "merge-settled",
    });

    applyVisualFixtureTrace(dataset, {
      type: "big-win.count-end",
      sequence: 7,
      atMs: 5_500,
      amountMinor: "2000",
      tier: "bigwin",
    });
    applyVisualFixtureTrace(dataset, { type: "round.complete", sequence: 7 });
    expect(dataset.fixtureBigWinMilestone).toBe("count-end");
    expect(dataset.fixtureCompleteCount).toBe("1");

    applyVisualFixtureTrace(dataset, {
      type: "result.accepted",
      sequence: 8,
      roundId: "round-8",
      totalWinMinor: "0",
      balanceMinor: "100000",
      winCount: 0,
    });

    applyVisualFixtureTrace(dataset, {
      type: "win-record.hidden",
      sequence: 7,
      index: 0,
      count: 1,
      id: "stale-record",
      symbol: "TANK",
      amountMinor: "10",
      multiplier: 1,
    });
    applyVisualFixtureTrace(dataset, { type: "round.complete", sequence: 8 });
    expect(dataset.fixtureRecordId).toBeUndefined();
    expect(dataset.fixtureCompleteCount).toBe("2");

    clearVisualFixtureTrace(dataset);
    expect(dataset).toEqual({});
  });

  it("projects one resident pool across handoff and fails a stale hidden without owner rollback", () => {
    const dataset: VisualFixtureDataset = {};
    const pass39Keys = [
      "fixtureTraceHistory",
      "fixtureStaleHidden",
      "fixtureTraceViolation",
      "fixtureResidentGeneration",
      "fixtureResidentLabelInstanceId",
      "fixtureResidentFramePoolInstanceId",
      "fixtureResidentFramePoolSize",
      "fixtureResidentPool24",
      "fixtureResidentActiveBoxCount",
      "fixtureResidentActiveOwnerCount",
      "fixtureResidentPendingCleanupCount",
      "fixtureResidentViewReused",
      "fixtureResidentHandoffDelayMs",
      "fixtureResidentStaleHiddenCount",
    ] as const;
    const resident = (
      generation: number,
      overrides: Partial<{
        activeBoxCount: number;
        activeOwnerCount: number;
        pendingCleanupCount: number;
        viewReused: boolean;
        handoffDelayMs: number;
        staleHiddenCount: number;
      }> = {},
    ) => ({
      generation,
      labelInstanceId: 71,
      framePoolInstanceId: 72,
      framePoolSize: 24,
      activeBoxCount: 3,
      activeOwnerCount: 1,
      pendingCleanupCount: 0,
      viewReused: generation > 1,
      handoffDelayMs: 0,
      staleHiddenCount: 0,
      ...overrides,
    });
    const recordTrace = (
      index: number,
      phase: "show-complete" | "hold-complete" | "hidden",
      facts: ReturnType<typeof resident>,
    ) => ({
      type: `win-record.${phase}` as const,
      sequence: 5,
      index,
      count: 2,
      id: index === 0 ? "prism-x2" : "orbit-x2",
      symbol: index === 0 ? "PRISM" as const : "ORBIT" as const,
      amountMinor: index === 0 ? "40" : "60",
      multiplier: 2,
      resident: facts,
    }) as AppPresentationTrace;

    expect(applyVisualFixtureTrace(dataset, {
      type: "result.accepted",
      sequence: 5,
      roundId: "round-5",
      totalWinMinor: "100",
      balanceMinor: "100060",
      winCount: 2,
    })).toBe(false);
    expect(applyVisualFixtureTrace(
      dataset,
      recordTrace(0, "show-complete", resident(1, { viewReused: false })),
    )).toBe(false);
    expect(applyVisualFixtureTrace(
      dataset,
      recordTrace(0, "hold-complete", resident(1)),
    )).toBe(false);
    expect(applyVisualFixtureTrace(
      dataset,
      recordTrace(1, "show-complete", resident(2)),
    )).toBe(false);

    expect(dataset).toMatchObject({
      fixtureSequence: "5",
      fixtureStage: "win-record.show-complete",
      fixtureRecordIndex: "1",
      fixtureRecordId: "orbit-x2",
      fixtureRecordPhase: "show-complete",
      fixtureResidentGeneration: "2",
      fixtureResidentLabelInstanceId: "71",
      fixtureResidentFramePoolInstanceId: "72",
      fixtureResidentFramePoolSize: "24",
      fixtureResidentPool24: "true",
      fixtureResidentActiveBoxCount: "3",
      fixtureResidentActiveOwnerCount: "1",
      fixtureResidentPendingCleanupCount: "0",
      fixtureResidentViewReused: "true",
      fixtureResidentHandoffDelayMs: "0",
      fixtureResidentStaleHiddenCount: "0",
      fixtureTraceHistory:
        "5:0:show-complete,5:0:hold-complete,5:1:show-complete",
    });

    expect(applyVisualFixtureTrace(
      dataset,
      recordTrace(0, "hidden", resident(1, {
        activeBoxCount: 0,
        activeOwnerCount: 0,
        staleHiddenCount: 1,
      })),
    )).toBe(true);
    expect(dataset).toMatchObject({
      fixtureStage: "win-record.show-complete",
      fixtureRecordIndex: "1",
      fixtureRecordId: "orbit-x2",
      fixtureResidentGeneration: "2",
      fixtureResidentActiveOwnerCount: "1",
      fixtureResidentStaleHiddenCount: "0",
      fixtureStaleHidden: "5:0:prism-x2",
      fixtureTraceViolation: "stale-hidden-owner-regression",
      fixtureTraceHistory:
        "5:0:show-complete,5:0:hold-complete,5:1:show-complete,5:0:hidden:stale",
    });

    applyVisualFixtureTrace(dataset, {
      type: "result.accepted",
      sequence: 6,
      roundId: "round-6",
      totalWinMinor: "2000",
      balanceMinor: "101960",
      winCount: 1,
    });
    for (const key of pass39Keys) expect(dataset[key]).toBeUndefined();

    for (const key of pass39Keys) dataset[key] = "stale";
    clearVisualFixtureTrace(dataset);
    expect(dataset).toEqual({});
  });

  it("fails closed on an intermediate hidden before takeover, duplicate final hidden, and false resident proof", () => {
    const accepted = (): VisualFixtureDataset => {
      const dataset: VisualFixtureDataset = {};
      applyVisualFixtureTrace(dataset, {
        type: "result.accepted",
        sequence: 5,
        roundId: "round-5",
        totalWinMinor: "100",
        balanceMinor: "100060",
        winCount: 2,
      });
      return dataset;
    };
    const resident = (generation: number, overrides = {}) => ({
      generation,
      labelInstanceId: 71,
      framePoolInstanceId: 72,
      framePoolSize: 24,
      activeBoxCount: 3,
      activeOwnerCount: 1,
      pendingCleanupCount: 0,
      viewReused: generation > 1,
      handoffDelayMs: 0,
      staleHiddenCount: 0,
      ...overrides,
    });
    const recordTrace = (
      index: number,
      phase: "show-complete" | "hidden",
      facts: ReturnType<typeof resident>,
    ) => ({
      type: `win-record.${phase}` as const,
      sequence: 5,
      index,
      count: 2,
      id: index === 0 ? "prism-x2" : "orbit-x2",
      symbol: index === 0 ? "PRISM" as const : "ORBIT" as const,
      amountMinor: index === 0 ? "40" : "60",
      multiplier: 2,
      resident: facts,
    }) as AppPresentationTrace;

    const earlyHidden = accepted();
    expect(applyVisualFixtureTrace(
      earlyHidden,
      recordTrace(0, "show-complete", resident(1)),
    )).toBe(false);
    expect(applyVisualFixtureTrace(
      earlyHidden,
      recordTrace(0, "hidden", resident(1, {
        activeBoxCount: 0,
        activeOwnerCount: 0,
      })),
    )).toBe(true);
    expect(earlyHidden.fixtureTraceViolation).toBe("intermediate-hidden-before-successor");

    const duplicateFinal = accepted();
    expect(applyVisualFixtureTrace(
      duplicateFinal,
      recordTrace(0, "show-complete", resident(1)),
    )).toBe(false);
    expect(applyVisualFixtureTrace(
      duplicateFinal,
      recordTrace(1, "show-complete", resident(2)),
    )).toBe(false);
    const finalHidden = recordTrace(1, "hidden", resident(2, {
      activeBoxCount: 0,
      activeOwnerCount: 0,
    }));
    expect(applyVisualFixtureTrace(duplicateFinal, finalHidden)).toBe(false);
    expect(applyVisualFixtureTrace(duplicateFinal, finalHidden)).toBe(true);
    expect(duplicateFinal.fixtureTraceViolation).toBe("duplicate-current-hidden");

    const falsePool = accepted();
    expect(applyVisualFixtureTrace(
      falsePool,
      recordTrace(0, "show-complete", resident(1, { framePoolSize: 0 })),
    )).toBe(true);
    expect(falsePool.fixtureTraceViolation).toBe("resident-pool-size");

    const delayedHandoff = accepted();
    expect(applyVisualFixtureTrace(
      delayedHandoff,
      recordTrace(0, "show-complete", resident(1)),
    )).toBe(false);
    expect(applyVisualFixtureTrace(
      delayedHandoff,
      recordTrace(1, "show-complete", resident(2, { handoffDelayMs: 0.25 })),
    )).toBe(true);
    expect(delayedHandoff.fixtureTraceViolation).toBe("resident-handoff-delay");
  });

  it("projects only active Vault phase, step, prize, multiplier, and cell", () => {
    const dataset: VisualFixtureDataset = {};
    applyVisualFixtureFeatureEvent(dataset, "vault.upgraded", {
      type: "vault.upgraded",
      reel: 2,
      row: 1,
      fromMultiplier: 250,
      toMultiplier: 1_000,
      prize: "GRAND",
      step: 2,
    });
    expect(dataset).toEqual({
      fixtureVaultPhase: "vault.upgraded",
      fixtureVaultStep: "2",
      fixtureVaultPrize: "GRAND",
      fixtureVaultMultiplier: "1000",
      fixtureVaultCell: "2:1",
    });

    applyVisualFixtureFeatureEvent(dataset, "surge.collected", {
      type: "surge.collected",
      count: 1,
      cells: [{ reel: 0, row: 0 }],
      triggered: false,
      guaranteed: false,
      level: 1,
      total: 1,
    });
    expect(dataset).toEqual({});

    dataset.fixtureVaultPhase = "stale";
    clearVisualFixtureVault(dataset);
    expect(dataset).toEqual({});
  });

  it("fail-closes Pass45 on any event path other than exact-three Rage to Wheel Ready", () => {
    const scenario = "base-three-rage-wheel-entry";
    const dataset: VisualFixtureDataset = {};
    expect(applyVisualFixtureTrace(dataset, {
      type: "result.accepted",
      sequence: 1,
      roundId: "round-base-three-rage-wheel-entry",
      totalWinMinor: "1000",
      balanceMinor: "100900",
      winCount: 0,
    }, scenario)).toBe(false);

    expect(applyVisualFixtureFeatureEvent(dataset, "vaults.landed", {
      type: "vaults.landed",
      count: 1,
      cells: [{ reel: 1, row: 2 }],
    }, scenario)).toBe(false);
    expect(applyVisualFixtureFeatureEvent(dataset, "vaults.locked", {
      type: "vaults.locked",
      count: 1,
      cells: [{ reel: 1, row: 2 }],
    }, scenario)).toBe(false);
    expect(applyVisualFixtureFeatureEvent(dataset, "surge.collected", {
      type: "surge.collected",
      count: 3,
      cells: [{ reel: 0, row: 1 }, { reel: 1, row: 0 }, { reel: 2, row: 2 }],
      triggered: true,
      guaranteed: true,
      level: 1,
      total: 0,
    }, scenario)).toBe(false);
    expect(applyVisualFixtureFeatureEvent(
      dataset,
      "wheel.started",
      { type: "wheel.started" },
      scenario,
    )).toBe(false);
    expect(applyVisualFixtureFeatureEvent(dataset, "wheel.awarded", {
      type: "wheel.awarded",
      outcome: "INSTANT",
      prize: "MINI",
      multiplier: 10,
      amountMinor: "1000",
    }, scenario)).toBe(false);

    expect(validatePass45SemanticCheckpoint(
      dataset,
      scenario,
      "wheel.popup-input-ready",
    )).toBeNull();
    expect(validatePass45SemanticCheckpoint(
      dataset,
      scenario,
      "wheel.input-ready",
    )).toBeNull();
    expect(dataset).toMatchObject({
      fixturePass45EventHistory:
        "vaults.landed,vaults.locked,surge.collected,wheel.started,wheel.awarded",
      fixturePass45EventCount: "5",
      fixturePass45Checkpoint: "wheel.input-ready",
    });

    expect(isPass45ForbiddenVisualTelemetryEvent(scenario, {
      schemaVersion: 1,
      kind: "start",
      id: "rage.cascade",
      operationId: 45,
      requirement: "conditional",
      mode: "authored",
    })).toBe(true);
    expect(isPass45ForbiddenVisualTelemetryEvent(scenario, {
      schemaVersion: 1,
      kind: "start",
      id: "wheel.popup",
      operationId: 46,
      requirement: "conditional",
      mode: "authored",
    })).toBe(false);
    expect(isPass45ForbiddenPresentationMilestone(scenario, "wheel.spin-start")).toBe(true);
    expect(isPass45ForbiddenPresentationMilestone(scenario, "wheel.input-ready")).toBe(false);
  });

  it("rejects malformed, transformed, win, and premature Pass45 paths", () => {
    const scenario = "base-three-rage-wheel-entry";
    const accepted = (): VisualFixtureDataset => {
      const dataset: VisualFixtureDataset = {};
      expect(applyVisualFixtureTrace(dataset, {
        type: "result.accepted",
        sequence: 1,
        roundId: "round-base-three-rage-wheel-entry",
        totalWinMinor: "1000",
        balanceMinor: "100900",
        winCount: 0,
      }, scenario)).toBe(false);
      return dataset;
    };

    const transformed = accepted();
    expect(applyVisualFixtureFeatureEvent(transformed, "rage.transformed", {
      type: "rage.transformed",
      count: 3,
      cells: [{ reel: 0, row: 1 }, { reel: 1, row: 0 }, { reel: 2, row: 2 }],
      level: 1,
      total: 0,
    }, scenario)).toBe(true);
    expect(transformed.fixturePass45Violation).toBe("pass45-feature-event-order");

    const ordinaryWin = accepted();
    expect(applyVisualFixtureTrace(ordinaryWin, {
      type: "counter.started",
      sequence: 1,
      totalWinMinor: "1000",
      displayStartMinor: "0",
      displayTotalMinor: "1000",
    }, scenario)).toBe(true);
    expect(ordinaryWin.fixturePass45Violation).toBe("pass45-unexpected-presentation-trace");

    const incomplete = accepted();
    expect(validatePass45SemanticCheckpoint(
      incomplete,
      scenario,
      "wheel.input-ready",
    )).toBe("pass45-feature-events-incomplete");

    const wrongResult: VisualFixtureDataset = {};
    expect(applyVisualFixtureTrace(wrongResult, {
      type: "result.accepted",
      sequence: 1,
      roundId: "round-base-three-rage-wheel-entry",
      totalWinMinor: "1000",
      balanceMinor: "100900",
      winCount: 1,
    }, scenario)).toBe(true);
    expect(wrongResult.fixturePass45Violation).toBe("pass45-result-contract");
  });

  it("projects only the active Free Spins completion facts and clears them deterministically", () => {
    const dataset: VisualFixtureDataset = { fixtureVaultPhase: "stale" };
    applyVisualFixtureTrace(dataset, {
      type: "result.accepted",
      sequence: 9,
      roundId: "round-9",
      totalWinMinor: "0",
      balanceMinor: "100000",
      winCount: 0,
    });
    applyVisualFixtureTrace(dataset, { type: "reels.settled", sequence: 9 });
    applyVisualFixtureFeatureEvent(dataset, "free_spins.completed", {
      type: "free_spins.completed",
      mode: "EXPANSION",
      awarded: 8,
      cumulativeWinMinor: "100",
    });
    expect(dataset).toEqual({
      fixtureCompletionMode: "EXPANSION",
      fixtureCompletionAwarded: "8",
      fixtureCompletionWinMinor: "100",
      fixtureSequence: "9",
      fixtureStage: "reels.settled",
      fixtureTotalWinMinor: "0",
      fixtureBalanceMinor: "100000",
    });

    applyVisualFixtureFeatureEvent(dataset, null);
    expect(dataset).toEqual({
      fixtureSequence: "9",
      fixtureStage: "reels.settled",
      fixtureTotalWinMinor: "0",
      fixtureBalanceMinor: "100000",
    });
    clearVisualFixtureTrace(dataset);
    expect(dataset).toEqual({});

    dataset.fixtureCompletionMode = "EXPANSION";
    dataset.fixtureCompletionAwarded = "8";
    dataset.fixtureCompletionWinMinor = "0";
    applyVisualFixtureTrace(dataset, {
      type: "result.accepted",
      sequence: 10,
      roundId: "round-10",
      totalWinMinor: "0",
      balanceMinor: "99900",
      winCount: 0,
    });
    expect(dataset.fixtureCompletionMode).toBeUndefined();
    expect(dataset.fixtureCompletionAwarded).toBeUndefined();
    expect(dataset.fixtureCompletionWinMinor).toBeUndefined();

    dataset.fixtureCompletionMode = "EXPANSION";
    clearVisualFixtureCompletion(dataset);
    expect(dataset.fixtureCompletionMode).toBeUndefined();
  });

  it("retains exact CAP and summary close branches across rounds until teardown", () => {
    const dataset: VisualFixtureDataset = {};
    applyVisualFixturePresentationBranch(dataset, {
      type: "free-spin-cap.closed",
      reason: "continue",
    });
    applyVisualFixtureTrace(dataset, {
      type: "result.accepted",
      sequence: 2,
      roundId: "round-2",
      totalWinMinor: "0",
      balanceMinor: "99900",
      winCount: 0,
    });
    applyVisualFixturePresentationBranch(dataset, {
      type: "free-spins.summary.closed",
      reason: "timeout",
    });

    expect(dataset).toMatchObject({
      fixtureCapCloseReason: "continue",
      fixtureCapCloseCount: "1",
      fixtureSummaryCloseReason: "timeout",
      fixtureSummaryCloseCount: "1",
      fixtureCloseHistory: "free-spin-cap:continue,free-spins-summary:timeout",
      fixtureSequence: "2",
    });

    clearVisualFixturePresentationBranches(dataset);
    expect(dataset.fixtureCapCloseReason).toBeUndefined();
    expect(dataset.fixtureCapCloseCount).toBeUndefined();
    expect(dataset.fixtureSummaryCloseReason).toBeUndefined();
    expect(dataset.fixtureSummaryCloseCount).toBeUndefined();
    expect(dataset.fixtureCloseHistory).toBeUndefined();
    expect(dataset.fixtureSequence).toBe("2");
  });

  it("releases a checkpoint by document event or the bounded 15-second timeout", async () => {
    vi.useFakeTimers();
    try {
      const target = new EventTarget();
      const releasedDataset: VisualFixtureDataset = {};
      const released = createVisualFixtureCheckpointHold(
        target,
        releasedDataset,
        "vault-awards-complete",
      );
      expect(releasedDataset.fixtureCheckpoint).toBe("vault-awards-complete");
      target.dispatchEvent(new Event("visual-fixture-release"));
      await released.promise;
      expect(releasedDataset.fixtureCheckpoint).toBeUndefined();

      const timedDataset: VisualFixtureDataset = {};
      const timed = createVisualFixtureCheckpointHold(
        target,
        timedDataset,
        "vault-awards-complete",
      );
      let timedOut = false;
      void timed.promise.then(() => { timedOut = true; });
      await vi.advanceTimersByTimeAsync(14_999);
      expect(timedOut).toBe(false);
      expect(timedDataset.fixtureCheckpoint).toBe("vault-awards-complete");
      await vi.advanceTimersByTimeAsync(1);
      await timed.promise;
      expect(timedOut).toBe(true);
      expect(timedDataset.fixtureCheckpoint).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases with fixture-only F8 and removes both release listeners", async () => {
    const target = new EventTarget();
    const removeEventListener = vi.spyOn(target, "removeEventListener");
    const dataset: VisualFixtureDataset = {};
    const hold = createVisualFixtureCheckpointHold(
      target,
      dataset,
      "win-record.visible",
    );
    let released = false;
    void hold.promise.then(() => { released = true; });

    const unrelatedKey = new Event("keydown");
    Object.defineProperty(unrelatedKey, "key", { value: "F7" });
    target.dispatchEvent(unrelatedKey);
    await Promise.resolve();
    expect(released).toBe(false);
    expect(dataset.fixtureCheckpoint).toBe("win-record.visible");

    expect(VISUAL_FIXTURE_RELEASE_KEY).toBe("F8");
    const releaseKey = new Event("keydown");
    Object.defineProperty(releaseKey, "key", { value: VISUAL_FIXTURE_RELEASE_KEY });
    target.dispatchEvent(releaseKey);
    await hold.promise;

    expect(released).toBe(true);
    expect(dataset.fixtureCheckpoint).toBeUndefined();
    expect(removeEventListener).toHaveBeenCalledWith("visual-fixture-release", expect.any(Function));
    expect(removeEventListener).toHaveBeenCalledWith("keydown", expect.any(Function));
  });
});
