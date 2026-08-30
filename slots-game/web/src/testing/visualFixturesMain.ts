import "../style.css";
import { AppController, type AppPresentationObserver } from "../app/AppController";
import { PLAYER_ERROR_DIAGNOSTIC_EVENT } from "../app/playerFacingError";
import type { FeatureState } from "../app/state/types";
import { AudioManager, type AudioBackend } from "../audio/AudioManager";
import type { GameGateway } from "../protocol/GameGateway";
import { configurePixiTextMetricsReadbackCanvas } from "../renderer/configurePixiTextMetricsReadbackCanvas";
import {
  VISUAL_TELEMETRY_ENTRY_REQUIRED_IDS,
  type VisualTelemetryEvent,
} from "../renderer/VisualTelemetry";
import {
  isVisualFixtureScenario,
  VisualFixtureGateway,
} from "./VisualFixtureGateway";
import {
  createRecoveredVisualFixtureGateway,
  RECOVERED_LEVEL_UP_VISUAL_FIXTURE_SCENARIO,
  type RecoveredVisualFixtureGateway,
} from "./RecoveredVisualFixtureGateway";
import { configurePixiContentSecurityPolicy } from "../startup/configurePixiContentSecurityPolicy";
import {
  applyPass49RecoveredAcknowledgement,
  baseVaultUnlockCaptureEnvironmentViolation,
  applyPass49RecoveredRoundPresentationState,
  applyPass49RecoveredUserSpinRequest,
  clearPass50CharacterIntroCapture,
  clearPass53CharacterWinCapture,
  clearPass54WheelCharacterCapture,
  clearPass55WheelChestCapture,
  clearVisualFixtureFailure,
  applyVisualFixtureFeatureEvent,
  applyPass47PresentationMilestone,
  applyPass47VisualTelemetryEvent,
  applyNormalWinContinueControlClick,
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
  isPass48RageAuraCapture,
  isPass49RecoveredLevelUpCapture,
  isPass50CharacterIntroCapture,
  isPass53CharacterWinCapture,
  isPass54WheelCharacterCapture,
  isPass55WheelChestCapture,
  isPass45ForbiddenPresentationMilestone,
  isPass45ForbiddenVisualTelemetryEvent,
  isVisualFixtureCheckpointCapture,
  isWinEffectsMatrixTraceCheckpoint,
  matchVisualFixtureSemanticCheckpoint,
  publishVisualFixtureTelemetryCounts,
  publishVisualFixtureFeatureEventProjection,
  publishVisualFixtureFailure,
  publishReelCabinetCompositionDiagnostics,
  publishBaseVaultUnlockCheckpoint,
  publishPass48RageAuraCheckpoint,
  publishPass49RecoveredResultAccepted,
  publishPass49RecoveredRoundComplete,
  publishPass50CharacterIntroCheckpoint,
  publishPass53CharacterWinCheckpoint,
  publishPass54WheelCharacterCheckpoint,
  publishPass55WheelChestCheckpoint,
  pass53CharacterWinCaptureEnvironmentViolation,
  pass53CharacterWinCheckpointElapsedMs,
  pass54WheelCharacterCaptureEnvironmentViolation,
  pass54WheelCharacterCheckpointElapsedMs,
  pass55WheelChestCaptureEnvironmentViolation,
  pass55WheelChestCheckpointElapsedMs,
  resolveVisualFixtureSemanticCheckpoint,
  projectVisualFixtureFeatureEvent,
  shouldProjectVisualFixtureTelemetryEvent,
  validatePass45SemanticCheckpoint,
  validatePass47SemanticCheckpoint,
  validatePass49RecoveredSemanticCheckpoint,
  visualFixturePlayerErrorCodeFromDetail,
  type Pass49RecoveredCaptureDiagnostics,
  type Pass49RecoveredGatewayFacts,
  type Pass50CharacterIntroCaptureDiagnostics,
  type Pass53CharacterWinCheckpoint,
  type Pass54WheelCharacterCheckpoint,
  type Pass55WheelChestCheckpoint,
  PASS50_CHARACTER_INTRO_LAUNCH_READY_CHECKPOINT,
  PASS50_CHARACTER_INTRO_LOOP_ENTERED_CHECKPOINT,
  type Pass48RageAuraCheckpoint,
  type VisualFixtureCheckpointHold,
  type VisualFixtureFailureSource,
} from "./visualFixtureObservation";

function observeFixtureFeatureStates(
  fixtureGateway: GameGateway,
  onSessionState: (state: Readonly<FeatureState>) => void,
  onRoundState: (
    state: Readonly<FeatureState>,
    originFeatureState?: Readonly<FeatureState>,
  ) => void,
  onSpinRequest?: (roundId: string, betMinor: string, accepted: boolean) => void,
  onAcknowledgement?: (
    roundId: string,
    sequence: number,
    accepted: boolean,
  ) => void,
): GameGateway {
  const observed: GameGateway = {
    get hasPendingSpin() {
      return fixtureGateway.hasPendingSpin;
    },
    setCallbacks: (callbacks): void => {
      fixtureGateway.setCallbacks({
        onStatus: (status) => callbacks.onStatus(status),
        onSession: (session) => {
          onSessionState(session.featureState);
          callbacks.onSession(session);
        },
        onSpinResult: (result, originFeatureState) => {
          onRoundState(result.featureState, originFeatureState);
          callbacks.onSpinResult(result, originFeatureState);
        },
        onError: (error) => callbacks.onError(error),
      });
    },
    connect: () => fixtureGateway.connect(),
    requestSpin: (roundId, betMinor) => {
      const accepted = fixtureGateway.requestSpin(roundId, betMinor);
      onSpinRequest?.(roundId, betMinor, accepted);
      return accepted;
    },
    close: () => fixtureGateway.close(),
  };
  // 临时测试夹具网关刻意省略 ACK。保留这种传输差异，不要伪造值为 undefined 的成功确认。 / English: The temporary test fixture gateway intentionally omits ACKs. Preserve this transfer difference and do not fake successful acknowledgments with a value of undefined.
  if (fixtureGateway.acknowledgeSpinResult) {
    observed.acknowledgeSpinResult = (roundId, sequence) => {
      const accepted = fixtureGateway.acknowledgeSpinResult?.(roundId, sequence) ?? false;
      onAcknowledgement?.(roundId, sequence, accepted);
      return accepted;
    };
  }
  return observed;
}

/**
 * 视觉夹具只验证可见表现与玩家输入门。它明确不覆盖音频解码或声画同步，
 * 因而使用无 I/O 的非权威音频负责人，避免把浏览器音频编解码器能力误记为视觉玩法失败。
 *
 * 英文 / English: The visual fixture only verifies visible representation and player input gates. It explicitly does not cover audio decoding or audio-visual synchronization, so using a non-authoritative audio manager without I/O avoids mistaking browser audio codec capabilities for visual gameplay failures.
 */
function createPresentationOnlyFixtureAudioManager(): AudioManager {
  const backend: AudioBackend = {
    available: true,
    state: "running",
    prime: () => Promise.resolve(),
    primeForLaunch: () => Promise.resolve(),
    unlock: () => Promise.resolve(true),
    setMuted: () => undefined,
    playOneShot: () => undefined,
    stopOneShot: () => undefined,
    startLoop: () => undefined,
    stopLoop: () => undefined,
    suspend: () => Promise.resolve(),
    destroy: () => undefined,
  };
  return new AudioManager({
    backend,
    storage: null,
    visibilitySource: null,
    focusSource: null,
    initialMuted: true,
  });
}

const body = document.body;
const root = document.querySelector<HTMLElement>("#app");
const searchParams = new URL(window.location.href).searchParams;
const scenario = searchParams.get("scenario") ?? "";
const capture = searchParams.get("capture");
const freeSpinsSummaryHold = searchParams.get("freeSpinsSummaryHold");
const checkpointQuery = searchParams.get("checkpoint");
const run = searchParams.get("run");
const PASS48_RAGE_AURA_SCENARIO = "base-rage-level-two-persistent-aura";
// 仅修饰捕获遍历。它可以对九个授权的爆炸访问进行排序，但不能选择两个服务器授权的替换地址。 / English: Only decorates the capture traversal. It can sort nine authorized blast accesses, but cannot select replacement addresses authorized by two servers.
const PASS47_RAGE_CASCADE_CELL_ORDER = Object.freeze([8, 7, 6, 5, 4, 3, 2, 1, 0]);
const requestedCheckpoint = resolveVisualFixtureSemanticCheckpoint(
  scenario,
  capture,
  checkpointQuery,
);
const checkpointCapture = isVisualFixtureCheckpointCapture(
  scenario,
  capture,
);
configurePixiContentSecurityPolicy();
configurePixiTextMetricsReadbackCanvas();
body.dataset.pixiCspMode = "static-uniform-sync";
body.dataset.visualFixture = scenario;
body.dataset.fixtureEvidenceScope = "presentation-only-no-rgs-settlement";
body.dataset.fixtureAudioCovered = "false";
body.dataset.fixtureStatus = "booting";
body.dataset.fixtureRoundState = "idle";
if (requestedCheckpoint) {
  body.dataset.fixtureRequestedCheckpoint = requestedCheckpoint;
}

if (!root) {
  publishVisualFixtureFailure(body.dataset, "fixture-contract", null, null);
  body.dataset.fixtureStatus = "failed";
  throw new Error("Visual fixture root is missing");
}

if (!isVisualFixtureScenario(scenario)) {
  publishVisualFixtureFailure(body.dataset, "fixture-contract", null, null);
  body.dataset.fixtureStatus = "failed";
  root.textContent = "Unknown or missing visual fixture scenario.";
} else {
  let app: AppController | null = null;
  const assemblyController = new AbortController();
  let destroyed = false;
  let tearingDown = false;
  let failureLocked = false;
  let normalWinContinueClickQueued = false;
  let checkpointHold: VisualFixtureCheckpointHold | null = null;
  let checkpointReleaseButton: HTMLButtonElement | null = null;
  let perspectiveDiagnosticsTimer: number | null = null;
  let characterCaptureTimer: number | null = null;
  let characterIntroPollTimer: number | null = null;
  let characterIntroPollTimeout: number | null = null;
  let pass55FirstPaintRaf: number | null = null;
  let pass55SecondPaintRaf: number | null = null;
  let launchReady = false;
  const pass48RageAuraCapture = scenario === PASS48_RAGE_AURA_SCENARIO
    && isPass48RageAuraCapture(scenario, capture);
  const pass49RecoveredCapture = scenario === RECOVERED_LEVEL_UP_VISUAL_FIXTURE_SCENARIO
    && isPass49RecoveredLevelUpCapture(scenario, capture);
  const pass50CharacterIntroCapture = isPass50CharacterIntroCapture(
    scenario,
    capture,
    checkpointQuery,
    run,
  );
  const pass52VaultUnlockCapture = scenario === "base-vault-unlock-x2"
    && capture === "1"
    && requestedCheckpoint?.startsWith("vault-unlock.") === true;
  const pass52VaultUnlockReducedMotion = pass52VaultUnlockCapture
    && (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);
  const pass52VaultUnlockCaptureEnabled = pass52VaultUnlockCapture
    && !pass52VaultUnlockReducedMotion;
  const pass53CharacterWinCapture = isPass53CharacterWinCapture(
    scenario,
    capture,
    checkpointQuery,
    run,
  );
  const pass53CharacterWinCheckpoint: Pass53CharacterWinCheckpoint | null =
    pass53CharacterWinCapture ? checkpointQuery : null;
  const pass53CharacterWinReducedMotion = pass53CharacterWinCapture
    && (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);
  const pass54WheelCharacterCapture = isPass54WheelCharacterCapture(
    scenario,
    capture,
    checkpointQuery,
    run,
  );
  const pass54WheelCharacterCheckpoint: Pass54WheelCharacterCheckpoint | null =
    pass54WheelCharacterCapture ? checkpointQuery : null;
  const pass54WheelCharacterReducedMotion = pass54WheelCharacterCapture
    && (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);
  const pass55WheelChestCapture = isPass55WheelChestCapture(
    scenario,
    capture,
    checkpointQuery,
    run,
  );
  const pass55WheelChestCheckpoint: Pass55WheelChestCheckpoint | null =
    pass55WheelChestCapture ? checkpointQuery : null;
  const pass55WheelChestReducedMotion = pass55WheelChestCapture
    && (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);
  const requiresNeutralCharacterCapture = capture === "1"
    && (scenario === "base-three-rage-wheel-entry"
      || pass48RageAuraCapture);
  const requiresSpinMessageCapture = capture === "1"
    && (scenario === "base-three-rage-wheel-entry"
      || scenario === "base-two-rage-no-wheel");
  let characterCaptureReady = !requiresNeutralCharacterCapture;
  let pass48RestoredState: Readonly<FeatureState> | null = null;
  let pass48FinalState: Readonly<FeatureState> | null = null;
  let recoveredFixtureGateway: RecoveredVisualFixtureGateway | null = null;
  let pass49FinalState: Readonly<FeatureState> | null = null;
  let pass49RoundState: "idle" | "requested" | "presenting" | "complete" | "failed" = "idle";
  let pass49AcknowledgementAttemptCount = 0;
  let pass49AcknowledgementAcceptedCount = 0;
  let pass49UserSpinRequestCount = 0;
  let pass50SessionState: Readonly<FeatureState> | null = null;
  let pass50SpinRequestCount = 0;
  let pass50RoundDeliveryCount = 0;
  let pass50FeatureEventCount = 0;
  let pass50LaunchReadyDiagnostics: Pass50CharacterIntroCaptureDiagnostics | null = null;
  let pass53CharacterWinPublished = false;
  let pass54WheelCharacterPublished = false;
  let pass55WheelChestPublished = false;
  const presentationMilestones: string[] = [];
  let featureEventProjection = createVisualFixtureFeatureEventProjection();
  const visualTelemetryState = createVisualFixtureTelemetryProjectionState(
    VISUAL_TELEMETRY_ENTRY_REQUIRED_IDS,
  );
  publishVisualFixtureFeatureEventProjection(body.dataset, featureEventProjection);
  publishVisualFixtureTelemetryCounts(body.dataset, visualTelemetryState);

  const pass49GatewayFacts = (): Pass49RecoveredGatewayFacts => {
    const diagnostics = recoveredFixtureGateway?.diagnostics;
    return {
      pendingAtSession: diagnostics?.pendingAtSession ?? false,
      pendingAtResult: diagnostics?.pendingAtResult ?? false,
      deliveredBeforeLaunch: diagnostics?.deliveredBeforeLaunch ?? false,
      deliveryCount: diagnostics?.deliveryCount ?? 0,
      gatewayAcknowledgementCount: diagnostics?.acknowledgementCount ?? 0,
      acknowledgementAttemptCount: pass49AcknowledgementAttemptCount,
      acknowledgementAcceptedCount: pass49AcknowledgementAcceptedCount,
      userSpinRequestCount: pass49UserSpinRequestCount,
      pending: recoveredFixtureGateway?.hasPendingSpin ?? false,
      deliveredRoundId: diagnostics?.deliveredResult?.roundId ?? null,
      deliveredSequence: diagnostics?.deliveredResult?.sequence ?? null,
      originState: diagnostics?.deliveredOrigin ?? null,
      finalState: diagnostics?.deliveredResult?.featureState ?? null,
    };
  };

  const pass49CaptureDiagnostics = (): Pass49RecoveredCaptureDiagnostics => ({
    launchReady,
    roundState: pass49RoundState,
    gateway: pass49GatewayFacts(),
    state: pass49FinalState,
    tracks: app?.getCharacterCaptureDiagnostics() ?? [],
  });

  const pass50CaptureDiagnostics = (): Pass50CharacterIntroCaptureDiagnostics => {
    if (!app) throw new Error("Pass50 character diagnostics requested before assembly");
    return {
      launchReady,
      roundState: body.dataset.fixtureRoundState === "failed"
        ? "failed"
        : body.dataset.fixtureRoundState === "presenting"
          ? "presenting"
          : body.dataset.fixtureRoundState === "requested"
            ? "requested"
            : body.dataset.fixtureRoundState === "complete"
              ? "complete"
              : "idle",
      state: pass50SessionState,
      spinRequestCount: pass50SpinRequestCount,
      roundDeliveryCount: pass50RoundDeliveryCount,
      featureEventCount: pass50FeatureEventCount,
      tracks: app.getCharacterCaptureDiagnostics(),
      lifecycle: app.getCharacterIntroLifecycleCaptureDiagnostics(),
    };
  };

  const releaseCheckpointFromButton = (): void => {
    checkpointHold?.release();
  };
  if (capture === "1" || freeSpinsSummaryHold === "1") {
    document.querySelector('[data-role="fixture-checkpoint-release"]')?.remove();
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.role = "fixture-checkpoint-release";
    button.setAttribute("aria-label", "Release visual fixture checkpoint");
    button.tabIndex = -1;
    Object.assign(button.style, {
      appearance: "none",
      background: "transparent",
      border: "0",
      boxSizing: "border-box",
      display: "block",
      height: "1px",
      left: "0",
      margin: "0",
      maxHeight: "1px",
      maxWidth: "1px",
      minHeight: "1px",
      minWidth: "1px",
      opacity: "0",
      overflow: "hidden",
      padding: "0",
      pointerEvents: "auto",
      position: "fixed",
      top: "0",
      width: "1px",
      zIndex: "2147483647",
    });
    button.addEventListener("click", releaseCheckpointFromButton);
    body.appendChild(button);
    checkpointReleaseButton = button;
  }

  const fail = (source: VisualFixtureFailureSource = "fixture-contract"): boolean => {
    if (destroyed || failureLocked) return false;
    failureLocked = true;
    publishVisualFixtureFailure(
      body.dataset,
      source,
      featureEventProjection.event,
      body.dataset.fixtureSequence,
    );
    body.dataset.fixtureStatus = "failed";
    return true;
  };

  if (pass52VaultUnlockCapture) {
    body.dataset.fixtureVaultUnlockReducedMotion = String(pass52VaultUnlockReducedMotion);
    const violation = baseVaultUnlockCaptureEnvironmentViolation(
      scenario,
      capture,
      checkpointQuery,
      pass52VaultUnlockReducedMotion,
    );
    if (violation) {
      body.dataset.fixtureVaultUnlockEnvironmentViolation = violation;
      body.dataset.fixtureVaultUnlockViolation = violation;
      fail();
    }
  }

  if (pass53CharacterWinCapture) {
    body.dataset.fixtureCharacterWinReducedMotion = String(pass53CharacterWinReducedMotion);
    const violation = pass53CharacterWinCaptureEnvironmentViolation(
      scenario,
      capture,
      checkpointQuery,
      run,
      pass53CharacterWinReducedMotion,
    );
    if (violation) {
      body.dataset.fixtureCharacterWinViolation = violation;
      body.dataset.fixtureTraceViolation = violation;
      fail();
    }
  }

  if (pass54WheelCharacterCapture) {
    body.dataset.fixtureWheelCharacterReducedMotion = String(pass54WheelCharacterReducedMotion);
    const violation = pass54WheelCharacterCaptureEnvironmentViolation(
      scenario,
      capture,
      checkpointQuery,
      run,
      pass54WheelCharacterReducedMotion,
    );
    if (violation) {
      body.dataset.fixtureWheelCharacterViolation = violation;
      body.dataset.fixtureTraceViolation = violation;
      fail();
    }
  }

  if (pass55WheelChestCapture) {
    // AppController 开始时 FASTPLAY 已禁用。在发布之前，在同步自旋启动检查点再次对精确值进行采样。 / English: AppController starts with FASTPLAY disabled. The exact value is sampled again at a synchronized spin start checkpoint before publishing.
    body.dataset.fixtureWheelChestReducedMotion = String(pass55WheelChestReducedMotion);
    body.dataset.fixtureWheelChestFastPlay = "false";
    const violation = pass55WheelChestCaptureEnvironmentViolation(
      scenario,
      capture,
      checkpointQuery,
      run,
      pass55WheelChestReducedMotion,
      false,
    );
    if (violation) {
      body.dataset.fixtureWheelChestViolation = violation;
      body.dataset.fixtureTraceViolation = violation;
      fail();
    }
  }

  const failPass50CharacterIntro = (code: string): void => {
    if (body.dataset.fixtureCharacterIntroViolation === undefined) {
      body.dataset.fixtureCharacterIntroViolation = code;
    }
    if (body.dataset.fixtureTraceViolation === undefined) {
      body.dataset.fixtureTraceViolation = code;
    }
    fail();
  };

  const failPass53CharacterWin = (code: string): void => {
    if (body.dataset.fixtureCharacterWinViolation === undefined) {
      body.dataset.fixtureCharacterWinViolation = code;
    }
    if (body.dataset.fixtureTraceViolation === undefined) {
      body.dataset.fixtureTraceViolation = code;
    }
    fail();
  };

  const failPass54WheelCharacter = (code: string): void => {
    if (body.dataset.fixtureWheelCharacterViolation === undefined) {
      body.dataset.fixtureWheelCharacterViolation = code;
    }
    if (body.dataset.fixtureTraceViolation === undefined) {
      body.dataset.fixtureTraceViolation = code;
    }
    fail();
  };

  const failPass55WheelChest = (code: string): void => {
    if (body.dataset.fixtureWheelChestViolation === undefined) {
      body.dataset.fixtureWheelChestViolation = code;
    }
    if (body.dataset.fixtureTraceViolation === undefined) {
      body.dataset.fixtureTraceViolation = code;
    }
    fail();
  };

  const clearPass55PaintGate = (): void => {
    if (pass55FirstPaintRaf !== null) {
      window.cancelAnimationFrame(pass55FirstPaintRaf);
      pass55FirstPaintRaf = null;
    }
    if (pass55SecondPaintRaf !== null) {
      window.cancelAnimationFrame(pass55SecondPaintRaf);
      pass55SecondPaintRaf = null;
    }
  };

  const capturePass53CharacterWin = (sequence: number): void => {
    if (!pass53CharacterWinCapture
      || !pass53CharacterWinCheckpoint
      || destroyed
      || failureLocked) return;
    if (!app || pass53CharacterWinPublished) {
      failPass53CharacterWin(
        app ? "character-win-counter-start-duplicate" : "character-win-app-missing",
      );
      return;
    }
    if (!app.setCharacterIntroCapturePaused(true)) {
      failPass53CharacterWin("character-win-pause-rejected");
      return;
    }
    const elapsedMs = pass53CharacterWinCheckpointElapsedMs(pass53CharacterWinCheckpoint);
    if (!app.advanceBaseWinCharacterCapture(elapsedMs)) {
      failPass53CharacterWin("character-win-step-rejected");
      return;
    }
    const tracks = app.getCharacterCaptureDiagnostics();
    const lifecycle = app.getCharacterIntroLifecycleCaptureDiagnostics();
    const roundState = body.dataset.fixtureRoundState === "failed"
      ? "failed"
      : body.dataset.fixtureRoundState === "complete"
        ? "complete"
        : body.dataset.fixtureRoundState === "requested"
          ? "requested"
          : body.dataset.fixtureRoundState === "presenting"
            ? "presenting"
            : "idle";
    const diagnostics = Object.freeze({
      checkpoint: pass53CharacterWinCheckpoint,
      elapsedMs,
      sequence,
      roundState,
      bodyTrack: tracks.find((entry) => entry.track === 1) ?? null,
      tracks,
      lifecycle,
    });
    const violation = publishPass53CharacterWinCheckpoint(
      body.dataset,
      scenario,
      capture,
      checkpointQuery,
      run,
      diagnostics,
    );
    if (violation) {
      fail();
      return;
    }
    pass53CharacterWinPublished = true;
    checkpointHold?.release();
    const hold = createVisualFixtureCheckpointHold(
      document,
      body.dataset,
      pass53CharacterWinCheckpoint,
      60_000,
    );
    checkpointHold = hold;
    body.dataset.fixtureStatus = "ready";
    void hold.promise.then(() => {
      if (checkpointHold === hold) checkpointHold = null;
      if (!destroyed) app?.setCharacterIntroCapturePaused(false);
    });
  };

  const capturePass54WheelCharacter = (sequence: number): Promise<void> | void => {
    if (!pass54WheelCharacterCapture
      || !pass54WheelCharacterCheckpoint
      || destroyed
      || failureLocked) return;
    if (!app || pass54WheelCharacterPublished) {
      failPass54WheelCharacter(
        app ? "wheel-character-landing-duplicate" : "wheel-character-app-missing",
      );
      return;
    }
    // wheel.landing 在 wheel.spin 完成安装 Track 1 WIN 后立即同步调度，在下一个浏览器 RAF 之前。 / English: wheel.landing synchronizes the wheel.spin schedule immediately after it completes the installation of Track 1 WIN, before the next browser RAF.
    if (!app.setCharacterIntroCapturePaused(true)) {
      failPass54WheelCharacter("wheel-character-pause-rejected");
      return;
    }
    const elapsedMs = pass54WheelCharacterCheckpointElapsedMs(
      pass54WheelCharacterCheckpoint,
    );
    if (!app.advanceWheelWinFeatureCharacterCapture(elapsedMs)) {
      failPass54WheelCharacter("wheel-character-step-rejected");
      app.setCharacterIntroCapturePaused(false);
      return;
    }
    const tracks = app.getCharacterCaptureDiagnostics();
    const lifecycle = app.getCharacterIntroLifecycleCaptureDiagnostics();
    const roundState = body.dataset.fixtureRoundState === "failed"
      ? "failed"
      : body.dataset.fixtureRoundState === "complete"
        ? "complete"
        : body.dataset.fixtureRoundState === "requested"
          ? "requested"
          : body.dataset.fixtureRoundState === "presenting"
            ? "presenting"
            : "idle";
    const diagnostics = Object.freeze({
      checkpoint: pass54WheelCharacterCheckpoint,
      elapsedMs,
      sequence,
      roundState,
      bodyTrack: tracks.find((entry) => entry.track === 1) ?? null,
      tracks,
      lifecycle,
      milestoneHistory: Object.freeze([...presentationMilestones]),
      visualFailureCount: visualTelemetryState.visualFailureCount,
      featureEvent: body.dataset.fixtureEvent ?? null,
      totalWinMinor: body.dataset.fixtureTotalWinMinor ?? null,
      balanceMinor: body.dataset.fixtureBalanceMinor ?? null,
    });
    const violation = publishPass54WheelCharacterCheckpoint(
      body.dataset,
      scenario,
      capture,
      checkpointQuery,
      run,
      diagnostics,
    );
    if (violation) {
      fail();
      app.setCharacterIntroCapturePaused(false);
      return;
    }
    pass54WheelCharacterPublished = true;
    checkpointHold?.release();
    const hold = createVisualFixtureCheckpointHold(
      document,
      body.dataset,
      pass54WheelCharacterCheckpoint,
      60_000,
    );
    checkpointHold = hold;
    body.dataset.fixtureStatus = "ready";
    const captureHoldPromise = hold.promise;
    void captureHoldPromise.finally(() => {
      if (checkpointHold === hold) checkpointHold = null;
      if (!destroyed) app?.setCharacterIntroCapturePaused(false);
    });
    return captureHoldPromise;
  };

  const capturePass55WheelChest = (sequence: number): Promise<void> | void => {
    if (!pass55WheelChestCapture
      || !pass55WheelChestCheckpoint
      || destroyed
      || failureLocked) return;
    if (!app || pass55WheelChestPublished) {
      failPass55WheelChest(
        app ? "wheel-chest-spin-start-duplicate" : "wheel-chest-app-missing",
      );
      return;
    }
    // 在暂停或推进之前拒绝合同外回合 Character；失败的装置不能首先改变证据时钟。 / English: Reject an out-of-contract turn Character before pausing or advancing; the failing device cannot change the evidence clock first.
    if (sequence !== 1) {
      failPass55WheelChest("wheel-chest-sequence-not-canonical");
      return;
    }

    const environment = app.getWheelChestPoundCaptureEnvironmentDiagnostics();
    body.dataset.fixtureWheelChestFastPlay = String(environment.fastPlay);
    const environmentViolation = pass55WheelChestCaptureEnvironmentViolation(
      scenario,
      capture,
      checkpointQuery,
      run,
      pass55WheelChestReducedMotion,
      environment.fastPlay,
    );
    if (environmentViolation) {
      failPass55WheelChest(environmentViolation);
      return;
    }

    // wheel.chest-loop-start 是同步的：轨道 1 条目 #1 和 wheel.spin-start 里程碑存在，而 Wheel 延续仍然是 S0。 / English: wheel.chest-loop-start is synchronous: track 1 entry #1 and the wheel.spin-start milestone exist, while the Wheel continuation is still S0.
    if (!app.setCharacterIntroCapturePaused(true)) {
      failPass55WheelChest("wheel-chest-pause-rejected");
      return;
    }
    const targetSpinElapsedMs = pass55WheelChestCheckpointElapsedMs(
      pass55WheelChestCheckpoint,
    );
    if (!app.advanceWheelChestPoundCapture(targetSpinElapsedMs)) {
      failPass55WheelChest("wheel-chest-step-rejected");
      app.setCharacterIntroCapturePaused(false);
      return;
    }
    const task = app.getWheelChestPoundDiagnostics();
    if (!task) {
      failPass55WheelChest("wheel-chest-task-missing");
      app.setCharacterIntroCapturePaused(false);
      return;
    }
    const tracks = task.tracks;
    const lifecycle = app.getCharacterIntroLifecycleCaptureDiagnostics();
    const roundState = body.dataset.fixtureRoundState === "failed"
      ? "failed"
      : body.dataset.fixtureRoundState === "complete"
        ? "complete"
        : body.dataset.fixtureRoundState === "requested"
          ? "requested"
          : body.dataset.fixtureRoundState === "presenting"
            ? "presenting"
            : "idle";
    const diagnostics = Object.freeze({
      checkpoint: pass55WheelChestCheckpoint,
      targetSpinElapsedMs,
      sequence,
      roundState,
      fastPlay: environment.fastPlay,
      reducedMotion: pass55WheelChestReducedMotion,
      task,
      bodyTrack: tracks[1] ?? null,
      tracks,
      lifecycle,
      milestoneHistory: Object.freeze([...presentationMilestones]),
      visualFailureCount: visualTelemetryState.visualFailureCount,
      featureEvent: body.dataset.fixtureEvent ?? null,
      totalWinMinor: body.dataset.fixtureTotalWinMinor ?? null,
      balanceMinor: body.dataset.fixtureBalanceMinor ?? null,
    });
    const violation = publishPass55WheelChestCheckpoint(
      body.dataset,
      scenario,
      capture,
      checkpointQuery,
      run,
      diagnostics,
    );
    if (violation) {
      fail();
      app.setCharacterIntroCapturePaused(false);
      return;
    }

    pass55WheelChestPublished = true;
    checkpointHold?.release();
    const hold = createVisualFixtureCheckpointHold(
      document,
      body.dataset,
      pass55WheelChestCheckpoint,
      60_000,
    );
    checkpointHold = hold;
    body.dataset.fixtureStatus = "conditioning";

    // 嵌套的 RAF 保证在自动化可以观察到 fixtureStatus=ready 之前，至少有一个合成器绘制精确的 Character 姿势。 / English: Nested RAF guarantees that at least one compositor draws an accurate Character pose before the automation can observe fixtureStatus=ready.
    pass55FirstPaintRaf = window.requestAnimationFrame(() => {
      pass55FirstPaintRaf = null;
      if (destroyed || failureLocked || checkpointHold !== hold) return;
      pass55SecondPaintRaf = window.requestAnimationFrame(() => {
        pass55SecondPaintRaf = null;
        if (destroyed || failureLocked || checkpointHold !== hold) return;
        body.dataset.fixtureStatus = "ready";
      });
    });

    const captureHoldPromise = hold.promise;
    void captureHoldPromise.finally(() => {
      if (checkpointHold === hold) checkpointHold = null;
      clearPass55PaintGate();
      if (!destroyed) app?.setCharacterIntroCapturePaused(false);
    });
    return captureHoldPromise;
  };

  const clearPass50LoopObservation = (): void => {
    if (characterIntroPollTimer !== null) {
      window.clearInterval(characterIntroPollTimer);
      characterIntroPollTimer = null;
    }
    if (characterIntroPollTimeout !== null) {
      window.clearTimeout(characterIntroPollTimeout);
      characterIntroPollTimeout = null;
    }
  };

  const holdPass50LoopEntered = (): void => {
    if (!app || !pass50LaunchReadyDiagnostics || destroyed || failureLocked) return;
    if (!app.setCharacterIntroCapturePaused(true)) {
      failPass50CharacterIntro("character-intro-loop-pause-rejected");
      return;
    }
    const diagnostics = pass50CaptureDiagnostics();
    const violation = publishPass50CharacterIntroCheckpoint(
      body.dataset,
      scenario,
      capture,
      checkpointQuery,
      run,
      PASS50_CHARACTER_INTRO_LOOP_ENTERED_CHECKPOINT,
      diagnostics,
      pass50LaunchReadyDiagnostics,
    );
    if (violation) {
      fail();
      return;
    }
    const hold = createVisualFixtureCheckpointHold(
      document,
      body.dataset,
      PASS50_CHARACTER_INTRO_LOOP_ENTERED_CHECKPOINT,
      60_000,
    );
    checkpointHold = hold;
    body.dataset.fixtureStatus = "ready";
    void hold.promise.then(() => {
      if (checkpointHold === hold) checkpointHold = null;
      if (!destroyed) app?.setCharacterIntroCapturePaused(false);
    });
  };

  const beginPass50LoopObservation = (): void => {
    if (!app || destroyed || failureLocked) return;
    if (!app.setCharacterIntroCapturePaused(false)) {
      failPass50CharacterIntro("character-intro-resume-rejected");
      return;
    }
    const observeLoopEntry = (): void => {
      if (!app || destroyed || failureLocked) return;
      const tracks = app.getCharacterCaptureDiagnostics();
      const bodyTrack = tracks.find((entry) => entry.track === 1);
      if (bodyTrack?.animation === "idle" && bodyTrack.mixingFrom === "intro") {
        clearPass50LoopObservation();
        holdPass50LoopEntered();
        return;
      }
      const lifecycle = app.getCharacterIntroLifecycleCaptureDiagnostics();
      if (!lifecycle.introActive && bodyTrack?.animation !== "idle") {
        clearPass50LoopObservation();
        failPass50CharacterIntro("character-intro-unexpected-handoff");
      }
    };
    characterIntroPollTimer = window.setInterval(observeLoopEntry, 4);
    characterIntroPollTimeout = window.setTimeout(() => {
      clearPass50LoopObservation();
      failPass50CharacterIntro("character-intro-loop-timeout");
    }, 6_000);
    observeLoopEntry();
  };

  const holdPass50LaunchReady = (): void => {
    if (!app || destroyed || failureLocked || !pass50CharacterIntroCapture) return;
    if (!app.setCharacterIntroCapturePaused(true)) {
      failPass50CharacterIntro("character-intro-launch-pause-rejected");
      return;
    }
    const diagnostics = pass50CaptureDiagnostics();
    const violation = publishPass50CharacterIntroCheckpoint(
      body.dataset,
      scenario,
      capture,
      checkpointQuery,
      run,
      PASS50_CHARACTER_INTRO_LAUNCH_READY_CHECKPOINT,
      diagnostics,
    );
    if (violation) {
      fail();
      return;
    }
    pass50LaunchReadyDiagnostics = diagnostics;
    const hold = createVisualFixtureCheckpointHold(
      document,
      body.dataset,
      PASS50_CHARACTER_INTRO_LAUNCH_READY_CHECKPOINT,
      60_000,
    );
    checkpointHold = hold;
    body.dataset.fixtureStatus = "ready";
    void hold.promise.then(() => {
      if (checkpointHold === hold) checkpointHold = null;
      beginPass50LoopObservation();
    });
  };

  const publishPass48Checkpoint = (
    checkpoint: Pass48RageAuraCheckpoint,
    state: Readonly<FeatureState> | null,
  ): void => {
    if (!pass48RageAuraCapture || !app || destroyed || failureLocked) return;
    checkpointHold?.release();
    const violation = publishPass48RageAuraCheckpoint(
      body.dataset,
      scenario,
      capture,
      checkpoint,
      {
        launchReady,
        neutralCharacterReady: characterCaptureReady,
        roundComplete: body.dataset.fixtureRoundState === "complete",
        state,
        tracks: app.getCharacterCaptureDiagnostics(),
      },
    );
    if (violation) {
      fail();
      return;
    }

    const hold = createVisualFixtureCheckpointHold(
      document,
      body.dataset,
      checkpoint,
      60_000,
    );
    checkpointHold = hold;
    void hold.promise.finally(() => {
      if (checkpointHold === hold) checkpointHold = null;
    });
  };

  const publishPass49FinalCheckpoint = (): void => {
    if (!pass49RecoveredCapture || !app || destroyed || failureLocked) return;
    checkpointHold?.release();
    const violation = publishPass49RecoveredRoundComplete(
      body.dataset,
      scenario,
      capture,
      pass49CaptureDiagnostics(),
    );
    if (violation) {
      fail();
      return;
    }
    const checkpoint = "rgs-level-up.round-complete" as const;
    const hold = createVisualFixtureCheckpointHold(
      document,
      body.dataset,
      checkpoint,
      60_000,
    );
    checkpointHold = hold;
    void hold.promise.finally(() => {
      if (checkpointHold === hold) checkpointHold = null;
    });
  };

  const handlePlayerErrorDiagnostic = (event: Event): void => {
    // 先取得首失败锁，再触碰可执行的 CustomEvent.detail getter；即使 getter 重入 / English: Obtain the first failure lock first, and then touch the executable CustomEvent.detail getter; even if the getter reentrants
    // console/error 观察面，也不能覆盖来源或把迟到 code 附到其他首失败上。 / English: The console/error observation surface also cannot overwrite the source or attach late code to other first failures.
    if (!fail("player-error")) return;
    const playerErrorCode = visualFixturePlayerErrorCodeFromDetail(
      event instanceof CustomEvent ? event.detail : null,
    );
    if (destroyed) return;
    if (playerErrorCode !== null) {
      body.dataset.fixturePlayerErrorCode = playerErrorCode;
    }
  };
  window.addEventListener(PLAYER_ERROR_DIAGNOSTIC_EVENT, handlePlayerErrorDiagnostic);

  const toastObserver = new MutationObserver(() => {
    if (root.querySelector('[data-role="toast"][data-visible="true"]')) fail("toast");
  });
  toastObserver.observe(root, {
    attributes: true,
    attributeFilter: ["data-visible"],
    childList: true,
    subtree: true,
  });

  const handleWindowError = (event: Event): void => {
    fail(event.target instanceof Element ? "resource-error" : "window-error");
  };
  const handleUnhandledRejection = (event: PromiseRejectionEvent): void => {
    // Firefox 也会把 Playwright 可恢复的截图时钟协议竞态发布为未处理页面拒绝。保持事件未处理， / English: Firefox will also post Playwright's resumable screenshot clock protocol race as an unhandled page rejection. Leave the event unhandled,
    // 使门禁仍能记录 pageerror，并且仅在精确协议拒绝与稳定暂停时钟共同证明恢复时才消化它。 / English: Enable the gatekeeper to still log a pageerror, and only digest it when an exact protocol rejection is demonstrated in conjunction with a stable pause clock to recover.
    if (body.dataset.fixtureCaptureClockGuard === "active"
      && isVisualFixtureCaptureClockPastTargetRejection(event.reason)) return;
    fail("unhandled-rejection");
  };
  // 捕获资源元素故障以及普通窗口错误。 / English: Catch resource element failures as well as normal window errors.
  window.addEventListener("error", handleWindowError, true);
  window.addEventListener("unhandledrejection", handleUnhandledRejection);

  const originalConsoleError = console.error;
  const fixtureConsoleError: typeof console.error = (...data) => {
    fail("console-error");
    originalConsoleError.apply(console, data);
  };
  console.error = fixtureConsoleError;

  const presentationObserver: AppPresentationObserver = {
    onVisualTelemetry: (event: Readonly<VisualTelemetryEvent>): void => {
      if (!shouldProjectVisualFixtureTelemetryEvent(destroyed, tearingDown, event)) return;
      applyVisualFixtureTelemetryEvent(body.dataset, visualTelemetryState, event);
      if (destroyed) return;
      if (applyPass47VisualTelemetryEvent(body.dataset, scenario, event)) {
        fail();
        return;
      }
      if (isPass45ForbiddenVisualTelemetryEvent(scenario, event)) {
        body.dataset.fixturePass45Violation = "pass45-rage-cascade-started";
        body.dataset.fixtureTraceViolation = "pass45-rage-cascade-started";
        fail();
        return;
      }
      // 条件失败事件仅在尝试该视觉路径之后才存在，因此它是严格测试场景中的激活条件。 / English: The conditional failure event only exists after trying that visual path, so it is the activation condition in a strict test scenario.
      if (event.kind === "fail"
        && (event.requirement === "required" || event.requirement === "conditional")) fail();
    },
    onFeatureEvent: (eventType, event): void => {
      if (destroyed) return;
      if (pass50CharacterIntroCapture && (eventType !== null || event !== null)) {
        pass50FeatureEventCount += 1;
        failPass50CharacterIntro("character-intro-feature-event-observed");
        return;
      }
      const nextFeatureEventProjection = projectVisualFixtureFeatureEvent(
        featureEventProjection,
        eventType,
        event,
      );
      if (!nextFeatureEventProjection) {
        body.dataset.fixtureTraceViolation = "feature-event-history-projection";
        fail();
        return;
      }
      featureEventProjection = nextFeatureEventProjection;
      publishVisualFixtureFeatureEventProjection(body.dataset, featureEventProjection);
      if (applyVisualFixtureFeatureEvent(body.dataset, eventType, event, scenario)) fail();
    },
    onLaunchPhase: (phase): void => {
      if (destroyed) return;
      if (phase === "failed") {
        // completeLaunchFailure 会在同一任务中紧接着发布安全玩家错误事件。把默认合同失败 / English: completeLaunchFailure will immediately post a safe player error event in the same mission. Fail the default contract
        // 留到微任务末端：存在该事件时它拥有首次来源；不存在时仍由默认失败闭合。 / English: Leave it to the end of the microtask: when the event exists, it has the first source; when it does not exist, it is still closed by default failure.
        queueMicrotask(() => fail());
      }
      else if (phase === "ready" && visualTelemetryState.missingRequiredVisualIds.size > 0) fail();
      else if (phase === "ready" && !failureLocked) {
        // 此回调在 INTRO_COMPLETE 之后但在控制器释放缓冲的恢复结果之前运行。此处仅冻结随机 Base 空闲调度程序， / English: This callback runs after INTRO_COMPLETE but before the controller releases the buffered resume results. Only the random Base idle scheduler is frozen here,
        // 以便 result.accepted 观察确定性原点姿势，而无需触及后来预设的收集轨道。 / English: so that result.accepted observes the deterministic origin pose without touching the later preset collection track.
        launchReady = true;
        if (pass50CharacterIntroCapture) {
          // 在启动回调中同步暂停：没有普通的 RAF 刻度线可以首先推进预设的 ~5000ms 屏幕截图姿势。 / English: Synchronous pauses in startup callbacks: There is no normal RAF tick to advance the preset ~5000ms screenshot pose first.
          holdPass50LaunchReady();
          return;
        }
        body.dataset.fixtureStatus = pass55WheelChestCapture
          ? "conditioning"
          : characterCaptureReady ? "ready" : "conditioning";
      }
    },
    onRoundPresentationState: (state): void => {
      if (destroyed) return;
      body.dataset.fixtureRoundState = state;
      if (pass50CharacterIntroCapture && state !== "idle") {
        failPass50CharacterIntro("character-intro-round-state-observed");
        return;
      }
      pass49RoundState = state;
      if (applyPass49RecoveredRoundPresentationState(
        body.dataset,
        scenario,
        capture,
        state,
      )) {
        fail();
        return;
      }
      if (state === "failed") fail();
    },
    onPresentationMilestone: (milestone): void => {
      if (destroyed) return;
      if (applyPass47PresentationMilestone(body.dataset, scenario, milestone)) {
        fail();
        return;
      }
      if (isPass45ForbiddenPresentationMilestone(scenario, milestone)) {
        body.dataset.fixturePass45Violation = "pass45-wheel-advanced-before-handoff";
        body.dataset.fixtureTraceViolation = "pass45-wheel-advanced-before-handoff";
        fail();
        return;
      }
      if (milestone) {
        body.dataset.fixtureMilestone = milestone;
        presentationMilestones.push(milestone);
        body.dataset.fixtureMilestones = presentationMilestones.join(",");
        body.dataset.fixtureMilestoneCount = String(presentationMilestones.length);
      } else {
        delete body.dataset.fixtureMilestone;
      }
    },
    onPresentationBranch: (branch): void => {
      if (destroyed) return;
      applyVisualFixturePresentationBranch(body.dataset, branch);
    },
    onPresentationTrace: (trace): void => {
      if (destroyed) return;
      if (applyVisualFixtureTrace(body.dataset, trace, scenario)) {
        fail();
        return;
      }
      if (pass53CharacterWinCapture && trace.type === "counter.started") {
        // AppController 在 reactToWin 安装了 Track 1 WIN 之后且在浏览器可以渲染下一个 RAF 之前同步发出此消息。 / English: AppController emits this message synchronously after reactToWin has installed Track 1 WIN and before the browser can render the next RAF.
        capturePass53CharacterWin(trace.sequence);
        return;
      }
      if (pass49RecoveredCapture && trace.type === "result.accepted") {
        const violation = publishPass49RecoveredResultAccepted(
          body.dataset,
          scenario,
          capture,
          pass49CaptureDiagnostics(),
        );
        if (violation) fail();
        return;
      }
      if (pass48RageAuraCapture && trace.type === "round.complete") {
        publishPass48Checkpoint(
          "rage-aura.inter-round-preserved",
          pass48FinalState,
        );
        return;
      }
      if (pass49RecoveredCapture && trace.type === "round.complete") {
        publishPass49FinalCheckpoint();
        return;
      }
      if (!isNormalWinContinueClickTrigger(scenario, capture, trace)) return;
      if (normalWinContinueClickQueued) {
        fail();
        return;
      }
      normalWinContinueClickQueued = true;
      queueMicrotask(() => {
        if (destroyed || failureLocked) return;
        const spin = root.querySelector<HTMLButtonElement>('[data-role="spin"]');
        const snapshot = () => ({
          mode: spin?.dataset.mode ?? null,
          action: spin?.dataset.action ?? null,
          disabled: spin?.disabled ?? true,
        });
        const rejected = applyNormalWinContinueControlClick(
          body.dataset,
          snapshot(),
          () => {
            spin?.click();
            return snapshot();
          },
        );
        if (rejected) fail();
      });
    },
    onPresentationCheckpoint: (checkpoint): Promise<void> | void => {
      if (destroyed) return;
      if (pass55WheelChestCapture
        && checkpoint.type === "semantic-state"
        && checkpoint.state === "wheel.chest-loop-start") {
        return capturePass55WheelChest(checkpoint.sequence);
      }
      if (pass54WheelCharacterCapture
        && checkpoint.type === "semantic-state"
        && checkpoint.state === "wheel.landing") {
        return capturePass54WheelCharacter(checkpoint.sequence);
      }
      let checkpointName: string | null = matchVisualFixtureSemanticCheckpoint(
        scenario,
        capture,
        requestedCheckpoint,
        checkpoint,
      );
      if (!checkpointName && checkpoint.type === "vault-awards-complete") {
        checkpointName = checkpointCapture ? checkpoint.type : null;
      } else if (!checkpointName && checkpoint.type === "free-spins-completed-active") {
        checkpointName = isNoSummaryTerminalCheckpointCapture(
          scenario,
          capture,
          checkpoint,
        ) ? checkpoint.type : null;
      } else if (!checkpointName && checkpoint.type === "bounded-gate-input-ready") {
        const capSummaryInputCapture = isCapSummaryInputCheckpointCapture(
          scenario,
          capture,
          checkpoint,
        );
        const durableFreeSpinsSummaryHold = isFreeSpinsSummaryInputCheckpointHold(
          scenario,
          freeSpinsSummaryHold,
          checkpoint,
        );
        checkpointName = capSummaryInputCapture || durableFreeSpinsSummaryHold
          ? `${checkpoint.gate}.input-ready`
          : null;
      } else if (!checkpointName
        && checkpoint.type === "presentation-trace"
        && isWinEffectsMatrixTraceCheckpoint(scenario, capture, checkpoint.trace)) {
        checkpointName = checkpoint.trace.type;
      }
      if (!checkpointName) return;
      if (checkpoint.type === "vault-unlock-phase"
        && scenario === "base-vault-unlock-x2") {
        const violation = publishBaseVaultUnlockCheckpoint(
          body.dataset,
          scenario,
          capture,
          requestedCheckpoint,
          checkpoint,
          app?.getVaultCaptureDiagnostics(checkpoint.cell) ?? null,
        );
        if (violation) {
          body.dataset.fixtureVaultUnlockViolation = violation;
          fail();
          return;
        }
      }
      const pass45Violation = validatePass45SemanticCheckpoint(
        body.dataset,
        scenario,
        checkpointName,
      );
      if (pass45Violation) {
        body.dataset.fixturePass45Violation = pass45Violation;
        body.dataset.fixtureTraceViolation = pass45Violation;
        fail();
        return;
      }
      const pass47Violation = validatePass47SemanticCheckpoint(
        body.dataset,
        scenario,
        checkpointName,
      );
      if (pass47Violation) {
        body.dataset.fixtureRageCascadeViolation = pass47Violation;
        body.dataset.fixtureTraceViolation = pass47Violation;
        fail();
        return;
      }
      const pass49Violation = validatePass49RecoveredSemanticCheckpoint(
        body.dataset,
        scenario,
        capture,
        checkpointName,
        pass49CaptureDiagnostics(),
      );
      if (pass49Violation) {
        fail();
        return;
      }
      checkpointHold?.release();
      const hold = createVisualFixtureCheckpointHold(
        document,
        body.dataset,
        checkpointName,
        // 浏览器视觉审查跨越流程/工具边界；保留准确的预设姿态足够长的时间，以获得确定性的屏幕截图。 / English: Browser visual review crosses process/tool ​​boundaries; retains accurate preset posture long enough to obtain conclusive screenshots.
        scenario === "win-effects-matrix"
          || scenario === "normal-win-continue"
          || scenario === "base-wild-reveal-x100"
          || scenario === "base-vault-unlock-x2"
          || scenario === "base-single-rage-no-wheel"
          || scenario === "base-two-rage-no-wheel"
          || scenario === RECOVERED_LEVEL_UP_VISUAL_FIXTURE_SCENARIO
          || scenario === "base-one-rage-trigger-transform"
          || (checkpoint.type === "bounded-gate-input-ready"
            && isFreeSpinsSummaryInputCheckpointHold(
              scenario,
              freeSpinsSummaryHold,
              checkpoint,
            ))
          ? 60_000
          : 15_000,
      );
      checkpointHold = hold;
      return hold.promise.finally(() => {
        if (checkpointHold === hold) checkpointHold = null;
      });
    },
  };

  const destroy = (): void => {
    if (destroyed) return;
    const appWasActive = app !== null;
    const activeApp = app;
    destroyed = true;
    assemblyController.abort(new Error("Visual fixture was disposed"));
    checkpointHold?.release();
    checkpointHold = null;
    checkpointReleaseButton?.removeEventListener("click", releaseCheckpointFromButton);
    checkpointReleaseButton?.remove();
    checkpointReleaseButton = null;
    clearPass55PaintGate();
    clearPass50LoopObservation();
    if (perspectiveDiagnosticsTimer !== null) {
      window.clearInterval(perspectiveDiagnosticsTimer);
      perspectiveDiagnosticsTimer = null;
    }
    if (characterCaptureTimer !== null) {
      window.clearInterval(characterCaptureTimer);
      characterCaptureTimer = null;
    }
    toastObserver.disconnect();
    window.removeEventListener(PLAYER_ERROR_DIAGNOSTIC_EVENT, handlePlayerErrorDiagnostic);
    window.removeEventListener("error", handleWindowError, true);
    window.removeEventListener("unhandledrejection", handleUnhandledRejection);
    window.removeEventListener("pagehide", destroy);
    if (console.error === fixtureConsoleError) console.error = originalConsoleError;
    activeApp?.setCharacterIntroCapturePaused(false);
    tearingDown = true;
    try {
      activeApp?.destroy();
    } finally {
      tearingDown = false;
    }
    const destroyedStreamingAssets = activeApp?.getDestroyedStreamingAssetDiagnostics() ?? null;
    const retainedPayloadBytesAfterDestroy =
      destroyedStreamingAssets?.retainedPayloadBytes ?? -1;
    const activeVisualCountAfterDestroy =
      activeApp?.getDestroyedVisualTelemetryActiveCount() ?? -1;
    const activeVisualProjectionCountAfterDestroy =
      visualTelemetryState.activeVisualOperations.size;
    app = null;
    featureEventProjection = createVisualFixtureFeatureEventProjection();
    clearVisualFixtureFeatureEventProjection(body.dataset);
    delete body.dataset.fixtureMilestone;
    delete body.dataset.fixtureMilestones;
    delete body.dataset.fixtureMilestoneCount;
    delete body.dataset.fixtureCheckpoint;
    delete body.dataset.fixtureRequestedCheckpoint;
    delete body.dataset.fixtureVisualKind;
    delete body.dataset.fixtureVisualId;
    delete body.dataset.fixtureVisualOperation;
    delete body.dataset.fixtureVisualLoadedCount;
    delete body.dataset.fixtureVisualActiveCount;
    delete body.dataset.fixtureVisualActiveIds;
    delete body.dataset.fixtureVisualActiveOperations;
    delete body.dataset.fixtureVisualFailureCount;
    delete body.dataset.fixtureVisualFailureCode;
    delete body.dataset.fixtureVisualFailureKind;
    delete body.dataset.fixtureVisualFailureId;
    delete body.dataset.fixtureVisualFailureOperation;
    delete body.dataset.fixtureVisualMissingRequired;
    delete body.dataset.fixtureCharacterCaptureReady;
    delete body.dataset.fixtureCharacterTracks;
    delete body.dataset.fixtureRageAuraCheckpoint;
    delete body.dataset.fixtureRageAuraState;
    delete body.dataset.fixtureRageAuraFeatureEventCount;
    delete body.dataset.fixtureRageAuraUnexpectedFeatureEvent;
    delete body.dataset.fixtureRageAuraRoundAcceptedCount;
    delete body.dataset.fixtureRageAuraSessionRestored;
    delete body.dataset.fixtureRageAuraInterRoundPreserved;
    delete body.dataset.fixtureRageAuraViolation;
    delete body.dataset.fixtureRgsRecoveredCheckpoint;
    delete body.dataset.fixtureRgsRecoveredPendingAtSession;
    delete body.dataset.fixtureRgsRecoveredPendingAtResult;
    delete body.dataset.fixtureRgsRecoveredDeliveredBeforeLaunch;
    delete body.dataset.fixtureRgsRecoveredDeliveryCount;
    delete body.dataset.fixtureRgsRecoveredGatewayAckCount;
    delete body.dataset.fixtureRgsRecoveredAckAttemptCount;
    delete body.dataset.fixtureRgsRecoveredAckAcceptedCount;
    delete body.dataset.fixtureRgsRecoveredAckRoundId;
    delete body.dataset.fixtureRgsRecoveredAckSequence;
    delete body.dataset.fixtureRgsRecoveredAckExact;
    delete body.dataset.fixtureRgsRecoveredPending;
    delete body.dataset.fixtureRgsRecoveredUserSpinCount;
    delete body.dataset.fixtureRgsRecoveredResultRoundId;
    delete body.dataset.fixtureRgsRecoveredResultSequence;
    delete body.dataset.fixtureRgsRecoveredOriginState;
    delete body.dataset.fixtureRgsRecoveredFinalState;
    delete body.dataset.fixtureRgsRecoveredResultTracks;
    delete body.dataset.fixtureRgsRecoveredTracks;
    delete body.dataset.fixtureRgsRecoveredAcceptedCount;
    delete body.dataset.fixtureRgsRecoveredResultAccepted;
    delete body.dataset.fixtureRgsRecoveredFeatureEventCount;
    delete body.dataset.fixtureRgsRecoveredFeatureEventHistory;
    delete body.dataset.fixtureRgsRecoveredPresentationStateHistory;
    delete body.dataset.fixtureRgsRecoveredPresentationCompleteCount;
    delete body.dataset.fixtureRgsRecoveredRoundComplete;
    delete body.dataset.fixtureRgsRecoveredViolation;
    delete body.dataset.fixtureSpinMessageReady;
    delete body.dataset.fixtureVaultUnlockReducedMotion;
    delete body.dataset.fixtureVaultUnlockEnvironmentViolation;
    pass48RestoredState = null;
    pass48FinalState = null;
    recoveredFixtureGateway = null;
    pass49FinalState = null;
    pass50SessionState = null;
    pass50LaunchReadyDiagnostics = null;
    clearPass50CharacterIntroCapture(body.dataset);
    clearPass53CharacterWinCapture(body.dataset);
    clearPass54WheelCharacterCapture(body.dataset);
    clearPass55WheelChestCapture(body.dataset);
    clearVisualFixtureTrace(body.dataset);
    clearVisualFixtureVault(body.dataset);
    clearVisualFixtureCompletion(body.dataset);
    clearVisualFixturePresentationBranches(body.dataset);
    clearVisualFixtureFailure(body.dataset);
    body.dataset.fixtureDestroyAppDisposed = String(appWasActive);
    body.dataset.fixtureDestroyCanvasCount = String(root.querySelectorAll("canvas").length);
    body.dataset.fixtureDestroyRetainedPayloadBytes = String(retainedPayloadBytesAfterDestroy);
    body.dataset.fixtureDestroySpinCount = String(
      root.querySelectorAll('[data-role="spin"]').length,
    );
    body.dataset.fixtureDestroyVisualActiveCount = String(activeVisualCountAfterDestroy);
    body.dataset.fixtureDestroyVisualProjectionActiveCount = String(
      activeVisualProjectionCountAfterDestroy,
    );
    body.dataset.fixtureStatus = "destroyed";
  };

  window.addEventListener("pagehide", destroy, { once: true });
  if (import.meta.hot) import.meta.hot.dispose(destroy);

  void (async () => {
    try {
      recoveredFixtureGateway = scenario === RECOVERED_LEVEL_UP_VISUAL_FIXTURE_SCENARIO
        ? createRecoveredVisualFixtureGateway(() => launchReady)
        : null;
      const fixtureGateway: GameGateway = recoveredFixtureGateway
        ?? new VisualFixtureGateway(scenario);
      const gateway = pass48RageAuraCapture || pass49RecoveredCapture
        || pass50CharacterIntroCapture
        ? observeFixtureFeatureStates(
            fixtureGateway,
            (state) => {
              if (pass48RageAuraCapture) pass48RestoredState = state;
              if (pass50CharacterIntroCapture) pass50SessionState = state;
            },
            (state) => {
              if (pass48RageAuraCapture) pass48FinalState = state;
              if (pass49RecoveredCapture) pass49FinalState = state;
              if (pass50CharacterIntroCapture) {
                pass50RoundDeliveryCount += 1;
                failPass50CharacterIntro("character-intro-result-observed");
              }
            },
            (_roundId, _betMinor, _accepted) => {
              if (pass50CharacterIntroCapture) {
                pass50SpinRequestCount += 1;
                failPass50CharacterIntro("character-intro-spin-request-observed");
              }
              if (!pass49RecoveredCapture) return;
              pass49UserSpinRequestCount += 1;
              if (applyPass49RecoveredUserSpinRequest(
                body.dataset,
                scenario,
                capture,
                pass49UserSpinRequestCount,
              )) fail();
            },
            (roundId, sequence, accepted) => {
              if (!pass49RecoveredCapture) return;
              pass49AcknowledgementAttemptCount += 1;
              if (accepted) pass49AcknowledgementAcceptedCount += 1;
              if (applyPass49RecoveredAcknowledgement(
                body.dataset,
                scenario,
                capture,
                pass49CaptureDiagnostics(),
                roundId,
                sequence,
                accepted,
              )) fail();
            },
          )
        : fixtureGateway;
      app = await AppController.create(root, {
        gateway,
        presentationObserver,
        audioManager: createPresentationOnlyFixtureAudioManager(),
        skipFeaturePreview: true,
        suppressPostWinIdleRepeat: true,
        vaultUnlockCaptureEnabled: pass52VaultUnlockCaptureEnabled,
        characterCollectRandomSource: scenario === "base-single-rage-no-wheel"
          || scenario === "base-two-rage-no-wheel"
          || scenario === RECOVERED_LEVEL_UP_VISUAL_FIXTURE_SCENARIO
          ? () => 0
          : undefined,
        rageCascadeCellOrderSource: scenario === "base-one-rage-trigger-transform"
          && capture === "1"
          ? () => PASS47_RAGE_CASCADE_CELL_ORDER
          : undefined,
      }, {
        signal: assemblyController.signal,
      });
      if (destroyed) {
        app.destroy();
        app = null;
        return;
      }
      app.start();
      if (requiresSpinMessageCapture) {
        if (!app.prepareSpinMessageCapture("The Ape unlocks the Vault Bonus!")) {
          fail();
        } else {
          body.dataset.fixtureSpinMessageReady = "true";
        }
      }
      if (requiresNeutralCharacterCapture) {
        const prepareCharacterCapture = (): void => {
          if (!app || !launchReady || destroyed || failureLocked || characterCaptureReady) return;
          if (!app.prepareNeutralCharacterCapture()) return;
          characterCaptureReady = true;
          body.dataset.fixtureCharacterCaptureReady = "true";
          if (characterCaptureTimer !== null) {
            window.clearInterval(characterCaptureTimer);
            characterCaptureTimer = null;
          }
          if (launchReady) body.dataset.fixtureStatus = "ready";
          if (pass48RageAuraCapture) {
            publishPass48Checkpoint(
              "rage-aura.session-restored",
              pass48RestoredState,
            );
          }
        };
        prepareCharacterCapture();
        if (!characterCaptureReady) {
          characterCaptureTimer = window.setInterval(prepareCharacterCapture, 16);
        }
      }
      const publishPerspectiveDiagnostics = (): void => {
        if (!app || destroyed) return;
        const diagnostics = app.getReelPerspectiveDiagnostics();
        const responsiveFrame = root.querySelector<HTMLElement>('[data-role="frame"]');
        if (responsiveFrame) {
          const rectangle = responsiveFrame.getBoundingClientRect();
          body.dataset.fixtureSurfaceProfile = responsiveFrame.dataset.surfaceProfile ?? "";
          body.dataset.fixtureDesignSurface = [
            responsiveFrame.dataset.designWidth ?? "",
            responsiveFrame.dataset.designHeight ?? "",
          ].join(",");
          body.dataset.fixtureLetterboxFrame = [
            rectangle.left,
            rectangle.top,
            rectangle.width,
            rectangle.height,
            responsiveFrame.dataset.frameScale ?? "",
          ].join(",");
        }
        body.dataset.fixtureReelFilterAppliedFrames = String(diagnostics.appliedFrames);
        body.dataset.fixtureReelFilterAttached = String(diagnostics.attached);
        body.dataset.fixtureReelFilterEnabled = String(diagnostics.enabled);
        body.dataset.fixtureReelFilterAutoFit = String(diagnostics.autoFit);
        body.dataset.fixtureReelFilterPadding = String(diagnostics.padding);
        body.dataset.fixtureReelFilterResolution = String(diagnostics.resolution);
        body.dataset.fixtureAnticipationFilterAppliedFrames = String(
          diagnostics.anticipation.appliedFrames,
        );
        body.dataset.fixtureAnticipationFilterAttached = String(
          diagnostics.anticipation.attached,
        );
        body.dataset.fixtureAnticipationFilterEnabled = String(
          diagnostics.anticipation.enabled,
        );
        body.dataset.fixtureAnticipationFilterResolution = String(
          diagnostics.anticipation.resolution,
        );
        body.dataset.fixtureAnticipationFilterDepth = String(
          diagnostics.anticipation.effectiveDepth,
        );
        body.dataset.fixtureAnticipationFilterAngle = diagnostics.anticipation.angle.join(",");
        body.dataset.fixtureAnticipationFilterBlendMode = String(
          diagnostics.anticipation.blendMode,
        );
        body.dataset.fixtureAnticipationFilterActive = String(diagnostics.anticipation.active);
        body.dataset.fixtureAnticipationFilterVisible = String(diagnostics.anticipation.visible);
        body.dataset.fixtureAnticipationFilterSourceFrame = diagnostics.anticipation.sourceFrame
          ? [
              diagnostics.anticipation.sourceFrame.x,
              diagnostics.anticipation.sourceFrame.y,
              diagnostics.anticipation.sourceFrame.width,
              diagnostics.anticipation.sourceFrame.height,
            ].join(",")
          : "";
        body.dataset.fixtureReelFilterSourceFrame = diagnostics.sourceFrame
          ? [
              diagnostics.sourceFrame.x,
              diagnostics.sourceFrame.y,
              diagnostics.sourceFrame.width,
              diagnostics.sourceFrame.height,
            ].join(",")
          : "";
        body.dataset.fixtureReelFilterTargetBounds = [
          diagnostics.targetBounds.x,
          diagnostics.targetBounds.y,
          diagnostics.targetBounds.width,
          diagnostics.targetBounds.height,
        ].join(",");
        body.dataset.fixtureRenderer = [
          diagnostics.screenWidth,
          diagnostics.screenHeight,
          diagnostics.rendererResolution,
        ].join(",");
        if (capture === "1") {
          publishReelCabinetCompositionDiagnostics(
            body.dataset,
            app.getReelCabinetCompositionDiagnostics(),
          );
        }
        if (requiresNeutralCharacterCapture) {
          body.dataset.fixtureCharacterTracks = JSON.stringify(
            app.getCharacterCaptureDiagnostics(),
          );
        }
      };
      publishPerspectiveDiagnostics();
      perspectiveDiagnosticsTimer = window.setInterval(publishPerspectiveDiagnostics, 250);
    } catch (error) {
      if (destroyed || assemblyController.signal.aborted) return;
      body.dataset.fixtureStartupError = error instanceof Error
        ? `${error.name}:${error.message}`.slice(0, 512)
        : "Unknown visual fixture startup error";
      fail();
      root.textContent = "Visual fixture failed to start.";
      originalConsoleError.call(console, error);
    }
  })();
}
