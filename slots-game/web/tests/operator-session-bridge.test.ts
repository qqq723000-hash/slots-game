import { describe, expect, it, vi } from "vitest";

import {
  OPERATOR_SESSION_HOST_MESSAGE_TYPE,
  OPERATOR_SESSION_HOST_MESSAGE_VERSION,
  notifyOperatorSessionRequired,
  parseExactHttpsHostOrigin,
} from "../src/app/operatorSessionBridge";
import { OPERATOR_SESSION_REQUIRED_EVENT } from "../src/app/playerFacingError";

class TestCustomEvent<T> {
  readonly detail: T;

  constructor(
    readonly type: string,
    init: { readonly detail: T },
  ) {
    this.detail = init.detail;
  }
}

describe("operator session host bridge", () => {
  it("accepts only a canonical credential-free HTTPS origin", () => {
    expect(parseExactHttpsHostOrigin(undefined)).toBeNull();
    expect(parseExactHttpsHostOrigin("https://operator.example")).toBe(
      "https://operator.example",
    );

    for (const value of [
      "",
      "*",
      "http://operator.example",
      "https://operator.example/",
      "https://operator.example/path",
      "https://operator.example?tenant=a",
      "https://operator.example#handoff",
      "https://user@operator.example",
      " https://operator.example",
    ]) {
      expect(() => parseExactHttpsHostOrigin(value), value).toThrow(
        /exact credential-free HTTPS origin/,
      );
    }
  });

  it("retains the same-page event and posts an allowlisted versioned message to the exact parent origin", () => {
    const postMessage = vi.fn();
    const dispatchEvent = vi.fn();
    const parent = { postMessage };
    const windowValue = {
      parent,
      dispatchEvent,
    } as unknown as Window;
    vi.stubGlobal("CustomEvent", TestCustomEvent);
    try {
      notifyOperatorSessionRequired(windowValue, {
        reason: "initial-session-failed",
        code: "OPERATOR_SESSION_REQUIRED",
        correlationId: "request-safe-7",
        rawMessage: "Bearer should-never-cross-the-bridge",
      } as never, "https://operator.example");

      expect(dispatchEvent).toHaveBeenCalledOnce();
      expect(dispatchEvent.mock.calls[0]?.[0]).toMatchObject({
        type: OPERATOR_SESSION_REQUIRED_EVENT,
        detail: {
          reason: "initial-session-failed",
          code: "OPERATOR_SESSION_REQUIRED",
          correlationId: "request-safe-7",
        },
      });
      expect(postMessage).toHaveBeenCalledOnce();
      expect(postMessage).toHaveBeenCalledWith({
        type: OPERATOR_SESSION_HOST_MESSAGE_TYPE,
        version: OPERATOR_SESSION_HOST_MESSAGE_VERSION,
        reason: "initial-session-failed",
        code: "OPERATOR_SESSION_REQUIRED",
        correlationId: "request-safe-7",
      }, "https://operator.example");
      expect(JSON.stringify(postMessage.mock.calls[0]?.[0])).not.toContain("Bearer");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("never posts to a wildcard, invalid origin, or a top-level window", () => {
    const postMessage = vi.fn();
    const dispatchEvent = vi.fn();
    const parent = { postMessage };
    const framedWindow = { parent, dispatchEvent } as unknown as Window;
    const topWindow = { dispatchEvent } as unknown as Window & { parent: Window };
    Object.defineProperty(topWindow, "parent", { value: topWindow });
    vi.stubGlobal("CustomEvent", TestCustomEvent);
    try {
      const request = {
        reason: "initial-session-timeout" as const,
        code: "SESSION_TIMEOUT" as const,
      };
      notifyOperatorSessionRequired(framedWindow, request, "*");
      notifyOperatorSessionRequired(framedWindow, request, "http://operator.example");
      notifyOperatorSessionRequired(topWindow, request, "https://operator.example");

      expect(postMessage).not.toHaveBeenCalled();
      expect(dispatchEvent).toHaveBeenCalledTimes(3);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("allowlists the committed-result recovery handoff without forwarding raw diagnostics", () => {
    const postMessage = vi.fn();
    const dispatchEvent = vi.fn();
    const windowValue = {
      parent: { postMessage },
      dispatchEvent,
    } as unknown as Window;
    vi.stubGlobal("CustomEvent", TestCustomEvent);
    try {
      notifyOperatorSessionRequired(windowValue, {
        reason: "committed-result-recovery-required",
        code: "OPERATOR_SESSION_REQUIRED",
        correlationId: "ack-request-8",
        responseBody: "wallet secret",
      } as never, "https://operator.example");

      expect(postMessage).toHaveBeenCalledWith({
        type: OPERATOR_SESSION_HOST_MESSAGE_TYPE,
        version: OPERATOR_SESSION_HOST_MESSAGE_VERSION,
        reason: "committed-result-recovery-required",
        code: "OPERATOR_SESSION_REQUIRED",
        correlationId: "ack-request-8",
      }, "https://operator.example");
      expect(JSON.stringify(postMessage.mock.calls[0]?.[0])).not.toContain("wallet secret");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each([
    {
      reason: "replay-consumed-launch-code",
      code: "OPERATOR_SESSION_REQUIRED",
    },
    {
      reason: "initial-session-failed",
      code: "LAUNCH_UNAVAILABLE",
    },
  ])("rejects untrusted runtime request values without notifying either channel", (request) => {
    const postMessage = vi.fn();
    const dispatchEvent = vi.fn();
    const windowValue = {
      parent: { postMessage },
      dispatchEvent,
    } as unknown as Window;
    vi.stubGlobal("CustomEvent", TestCustomEvent);
    try {
      notifyOperatorSessionRequired(
        windowValue,
        { ...request, rawMessage: "Bearer malicious-value" } as never,
        "https://operator.example",
      );

      expect(dispatchEvent).not.toHaveBeenCalled();
      expect(postMessage).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps the exact-origin parent channel available when the same-page event fails", () => {
    const postMessage = vi.fn();
    const windowValue = {
      parent: { postMessage },
      dispatchEvent: vi.fn(() => { throw new Error("same-page listener failed"); }),
    } as unknown as Window;
    vi.stubGlobal("CustomEvent", TestCustomEvent);
    try {
      expect(() => notifyOperatorSessionRequired(windowValue, {
        reason: "initial-session-timeout",
        code: "SESSION_TIMEOUT",
      }, "https://operator.example")).not.toThrow();
      expect(postMessage).toHaveBeenCalledWith({
        type: OPERATOR_SESSION_HOST_MESSAGE_TYPE,
        version: OPERATOR_SESSION_HOST_MESSAGE_VERSION,
        reason: "initial-session-timeout",
        code: "SESSION_TIMEOUT",
      }, "https://operator.example");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps the same-page channel complete when parent postMessage fails", () => {
    const dispatchEvent = vi.fn();
    const windowValue = {
      parent: { postMessage: vi.fn(() => { throw new Error("parent unavailable"); }) },
      dispatchEvent,
    } as unknown as Window;
    vi.stubGlobal("CustomEvent", TestCustomEvent);
    try {
      expect(() => notifyOperatorSessionRequired(windowValue, {
        reason: "initial-session-failed",
        code: "OPERATOR_SESSION_REQUIRED",
      }, "https://operator.example")).not.toThrow();
      expect(dispatchEvent).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
