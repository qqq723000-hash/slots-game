import { describe, expect, it, vi } from "vitest";

import {
  AppController,
  INITIAL_RGS_SESSION_TIMEOUT_MS,
  OPERATOR_SESSION_REQUIRED_EVENT,
  PLAYER_ERROR_DIAGNOSTIC_EVENT,
} from "../src/app/AppController";
import type { SessionOpened } from "../src/app/state/types";
import { PLAYER_FACING_ERROR_CODES } from "../src/app/playerFacingError";
import { LaunchStateMachine } from "../src/startup/LaunchStateMachine";

interface RgsRecoveryProbe {
  armInitialRgsSessionTimeout(): void;
  handleError(error: Error | { readonly type: "error"; readonly retryable: boolean }): void;
  handleOperatorSessionRequired(error: Error): void;
  handleSession(session: SessionOpened): void;
}

interface DispatchedEvent<T = unknown> {
  readonly type: string;
  readonly detail: T;
}

class TestCustomEvent<T> {
  constructor(
    readonly type: string,
    readonly init: { readonly detail: T },
  ) {}

  get detail(): T {
    return this.init.detail;
  }
}

function createRgsRecoveryProbe(): {
  readonly controller: RgsRecoveryProbe;
  readonly gateway: { readonly close: ReturnType<typeof vi.fn> };
  readonly launch: LaunchStateMachine;
  readonly showError: ReturnType<typeof vi.fn>;
  readonly abort: ReturnType<typeof vi.fn>;
  readonly requestNewSession: ReturnType<typeof vi.fn>;
  readonly reportDiagnostic: ReturnType<typeof vi.fn>;
  readonly applySession: ReturnType<typeof vi.fn>;
} {
  const controller = Object.create(AppController.prototype) as RgsRecoveryProbe;
  const launch = new LaunchStateMachine();
  launch.transition({ type: "START_PRELOAD" });
  const close = vi.fn();
  const showError = vi.fn();
  const abort = vi.fn();
  const requestNewSession = vi.fn();
  const reportDiagnostic = vi.fn();
  const applySession = vi.fn();

  Object.assign(controller, {
    destroyed: false,
    hasOpenedSession: false,
    gateway: {
      initialSessionRecoveryMode: "operator-session",
      operatorHostOrigin: "https://operator.example",
      hasPendingSpin: false,
      close,
    },
    launch,
    ui: { showError, applySession },
    renderer: {},
    preload: { abort },
    initialRgsSessionTimer: null,
    initialSessionFailure: null,
    initialSessionResolver: null,
    featurePreviewActive: false,
    featurePreviewResolver: null,
    featurePreviewContinuePending: false,
    operatorSessionRequestSent: false,
    lastPlayerFacingError: null,
    onOperatorSessionRequired: requestNewSession,
    onPlayerErrorDiagnostic: reportDiagnostic,
    syncLaunchUi: vi.fn(),
    refreshUi: vi.fn(),
  });

  return {
    controller,
    gateway: { close },
    launch,
    showError,
    abort,
    requestNewSession,
    reportDiagnostic,
    applySession,
  };
}

describe("AppController initial RGS session recovery", () => {
  it("times out a one-shot RGS launch, closes it, and asks the host for a new session", async () => {
    vi.useFakeTimers();
    const dispatched: DispatchedEvent[] = [];
    const postMessage = vi.fn();
    vi.stubGlobal("window", {
      parent: { postMessage },
      dispatchEvent: vi.fn((event: DispatchedEvent) => {
        dispatched.push(event);
        return true;
      }),
    });
    vi.stubGlobal("CustomEvent", TestCustomEvent);
    try {
      const probe = createRgsRecoveryProbe();

      probe.controller.armInitialRgsSessionTimeout();
      await vi.advanceTimersByTimeAsync(INITIAL_RGS_SESSION_TIMEOUT_MS - 1);
      expect(probe.gateway.close).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);

      expect(probe.gateway.close).toHaveBeenCalledOnce();
      expect(probe.abort).toHaveBeenCalledOnce();
      expect(probe.launch.phase).toBe("failed");
      expect(probe.showError).toHaveBeenCalledWith(
        "The game session did not start in time. Return to your operator and start a new session.",
      );
      expect(probe.reportDiagnostic).toHaveBeenCalledWith({
        code: PLAYER_FACING_ERROR_CODES.SESSION_TIMEOUT,
      });
      expect(probe.requestNewSession).toHaveBeenCalledWith({
        reason: "initial-session-timeout",
        code: PLAYER_FACING_ERROR_CODES.SESSION_TIMEOUT,
      });
      expect(dispatched.map(({ type }) => type)).toEqual([
        PLAYER_ERROR_DIAGNOSTIC_EVENT,
        OPERATOR_SESSION_REQUIRED_EVENT,
      ]);
      expect(postMessage).toHaveBeenCalledWith({
        type: OPERATOR_SESSION_REQUIRED_EVENT,
        version: 1,
        reason: "initial-session-timeout",
        code: PLAYER_FACING_ERROR_CODES.SESSION_TIMEOUT,
      }, "https://operator.example");

      // RGS launch code 是一次性凭据；迟到回调不得恢复已经失败的启动。
      probe.controller.handleSession({
        type: "session.opened",
        protocolVersion: 1,
        requestId: "late-session",
        sessionId: "session-1",
        balanceMinor: "10000",
        betOptionsMinor: ["100"],
        defaultBetMinor: "100",
        featureState: { mode: "BASE", freeSpinsRemaining: 0, rageLevel: 1, rageCollected: 0 },
      });
      expect(probe.launch.phase).toBe("failed");
      expect(probe.applySession).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("does not render a raw initial RGS error and preserves only its correlation ID", () => {
    const probe = createRgsRecoveryProbe();
    const rawMessage = "RGS failure: Authorization Bearer secret-value on wallet-internal";
    const error = Object.assign(new Error(rawMessage), { requestId: "operator-correlation-9" });

    probe.controller.handleError(error);

    expect(probe.showError).toHaveBeenCalledWith(
      "This game session is unavailable. Return to your operator and start a new session.",
    );
    expect(probe.showError).not.toHaveBeenCalledWith(rawMessage);
    expect(probe.reportDiagnostic).toHaveBeenCalledWith({
      code: PLAYER_FACING_ERROR_CODES.OPERATOR_SESSION_REQUIRED,
      correlationId: "operator-correlation-9",
    });
    expect(probe.requestNewSession).toHaveBeenCalledWith({
      reason: "initial-session-failed",
      code: PLAYER_FACING_ERROR_CODES.OPERATOR_SESSION_REQUIRED,
      correlationId: "operator-correlation-9",
    });
  });

  it("hands an exhausted committed-result acknowledgement to the host without clearing it locally", () => {
    const dispatched: DispatchedEvent[] = [];
    const postMessage = vi.fn();
    vi.stubGlobal("window", {
      parent: { postMessage },
      dispatchEvent: vi.fn((event: DispatchedEvent) => {
        dispatched.push(event);
        return true;
      }),
    });
    vi.stubGlobal("CustomEvent", TestCustomEvent);
    try {
      const probe = createRgsRecoveryProbe();
      Object.assign(probe.controller, { hasOpenedSession: true });
      const error = Object.assign(new Error("must never be displayed"), {
        requestId: "ack-correlation-7",
      });

      probe.controller.handleOperatorSessionRequired(error);

      expect(probe.gateway.close).not.toHaveBeenCalled();
      expect(probe.showError).toHaveBeenCalledWith(
        "This game session is unavailable. Return to your operator and start a new session.",
      );
      expect(probe.reportDiagnostic).toHaveBeenCalledWith({
        code: PLAYER_FACING_ERROR_CODES.OPERATOR_SESSION_REQUIRED,
        correlationId: "ack-correlation-7",
      });
      expect(probe.requestNewSession).toHaveBeenCalledWith({
        reason: "committed-result-recovery-required",
        code: PLAYER_FACING_ERROR_CODES.OPERATOR_SESSION_REQUIRED,
        correlationId: "ack-correlation-7",
      });
      expect(dispatched.map(({ type }) => type)).toEqual([
        PLAYER_ERROR_DIAGNOSTIC_EVENT,
        OPERATOR_SESSION_REQUIRED_EVENT,
      ]);
      expect(postMessage).toHaveBeenCalledWith({
        type: OPERATOR_SESSION_REQUIRED_EVENT,
        version: 1,
        reason: "committed-result-recovery-required",
        code: PLAYER_FACING_ERROR_CODES.OPERATOR_SESSION_REQUIRED,
        correlationId: "ack-correlation-7",
      }, "https://operator.example");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
