import { describe, expect, it, vi } from "vitest";

import {
  OPERATOR_SESSION_REQUIRED_EVENT,
  PLAYER_FACING_ERROR_CODES,
} from "../src/app/playerFacingError";

const LAUNCH_CODE = `lc_${"m".repeat(43)}`;

class TestCustomEvent<T> {
  readonly detail: T;

  constructor(
    readonly type: string,
    init: { readonly detail: T },
  ) {
    this.detail = init.detail;
  }
}

describe("main RGS bootstrap boundary", () => {
  it("scrubs a one-shot fragment and emits safe host recovery when storage is inaccessible", async () => {
    vi.resetModules();
    vi.stubEnv("VITE_RGS_BASE_URL", "https://rgs.example");
    vi.stubEnv("VITE_RGS_BET_OPTIONS_MINOR", "100");
    vi.stubEnv("VITE_RGS_DEFAULT_BET_MINOR", "100");
    vi.stubEnv("VITE_RGS_HOST_ORIGIN", "https://operator.example");
    const status = { textContent: "Loading game resources" };
    const loading = { querySelector: vi.fn(() => status) };
    const root = {
      dataset: {} as Record<string, string>,
      querySelector: vi.fn(() => loading),
    };
    const createElement = vi.fn();
    const replaceState = vi.fn();
    const dispatched: TestCustomEvent<unknown>[] = [];
    const dispatchEvent = vi.fn((event: TestCustomEvent<unknown>) => {
      dispatched.push(event);
      return true;
    });
    const postMessage = vi.fn();
    const pageUrl = `https://game.example/play#${new URLSearchParams({
      rgsLaunchCode: LAUNCH_CODE,
      rgsOperatorId: "operator-a",
      rgsSessionId: "session-a",
    })}`;
    const browserWindow = {
      location: { href: pageUrl },
      history: { state: null, replaceState },
      dispatchEvent,
      parent: { postMessage },
      get sessionStorage(): Storage {
        throw new DOMException("Blocked by browser policy", "SecurityError");
      },
    };
    const fetchImplementation = vi.fn<typeof fetch>();

    vi.stubGlobal("document", {
      querySelector: vi.fn(() => root),
      createElement,
    });
    vi.stubGlobal("window", browserWindow);
    vi.stubGlobal("CustomEvent", TestCustomEvent);
    vi.stubGlobal("fetch", fetchImplementation);
    try {
      const bootstrap = await import("../src/bootstrap");
      await bootstrap.applicationBootstrap;

      expect(replaceState).toHaveBeenCalledTimes(2);
      const replacement = String(replaceState.mock.calls[0]?.[2]);
      expect(replacement).not.toContain("rgsLaunchCode");
      expect(replacement).not.toContain(LAUNCH_CODE);
      expect(fetchImplementation).not.toHaveBeenCalled();
      expect(createElement).not.toHaveBeenCalled();
      expect(root.dataset).not.toHaveProperty("startupFrameMonitor");
      expect(root.dataset.startupAssemblyStage).toBe("assembly-failed");
      expect(status.textContent).toBe(
        "This game session is unavailable. Return to your operator and start a new session.",
      );
      expect(status.textContent).not.toContain("Blocked by browser policy");
      expect(dispatched).toHaveLength(1);
      expect(dispatched[0]).toMatchObject({
        type: OPERATOR_SESSION_REQUIRED_EVENT,
        detail: {
          reason: "initial-session-failed",
          code: PLAYER_FACING_ERROR_CODES.OPERATOR_SESSION_REQUIRED,
        },
      });
      expect(postMessage).toHaveBeenCalledOnce();
      expect(postMessage).toHaveBeenCalledWith({
        type: OPERATOR_SESSION_REQUIRED_EVENT,
        version: 1,
        reason: "initial-session-failed",
        code: PLAYER_FACING_ERROR_CODES.OPERATOR_SESSION_REQUIRED,
      }, "https://operator.example");
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});
