import { describe, expect, it, vi } from "vitest";
import mainSource from "../src/main.ts?raw";

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
  it("clears a late application reference even when its disposal throws", () => {
    const assignment = mainSource.indexOf("app = await ApplicationController.create");
    const start = mainSource.indexOf("app.start();", assignment);
    const lateAssemblyBoundary = mainSource.slice(assignment, start);

    expect(assignment).toBeGreaterThanOrEqual(0);
    expect(start).toBeGreaterThan(assignment);
    expect(lateAssemblyBoundary).toMatch(
      /if \(disposed\) \{[\s\S]*?try \{[\s\S]*?app\.destroy\(\);[\s\S]*?\} catch \{[\s\S]*?\} finally \{[\s\S]*?app = null;[\s\S]*?\}/u,
    );
  });

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
    const addEventListener = vi.fn();
    const removeEventListener = vi.fn();
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
      navigator: { onLine: true },
      addEventListener,
      removeEventListener,
      dispatchEvent,
      parent: { postMessage },
      get sessionStorage(): Storage {
        throw new DOMException("Blocked by browser policy", "SecurityError");
      },
    };
    const fetchImplementation = vi.fn<typeof fetch>();

    vi.stubGlobal("document", {
      visibilityState: "visible",
      querySelector: vi.fn(() => root),
      createElement,
      addEventListener,
      removeEventListener,
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
      expect(addEventListener).not.toHaveBeenCalled();
      expect(removeEventListener).not.toHaveBeenCalled();
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

  it("detaches every runtime listener when asynchronous application assembly fails", async () => {
    vi.resetModules();
    vi.stubEnv("VITE_RGS_BASE_URL", "https://rgs.example");
    vi.stubEnv("VITE_RGS_BET_OPTIONS_MINOR", "100");
    vi.stubEnv("VITE_RGS_DEFAULT_BET_MINOR", "100");
    vi.stubEnv("VITE_RGS_HOST_ORIGIN", "https://operator.example");
    const assemblyFailure = new Error("renderer internals must stay private");
    const createApplication = vi.fn(async () => { throw assemblyFailure; });
    vi.doMock("../src/app/AppController", () => ({
      AppController: { create: createApplication },
    }));
    vi.doMock("../src/startup/frameSlicedInitialization", () => ({
      waitForPaintedFrame: vi.fn(() => Promise.resolve()),
    }));

    const status = { textContent: "Loading game resources" };
    const loading = { querySelector: vi.fn(() => status) };
    const root = {
      dataset: {} as Record<string, string>,
      querySelector: vi.fn(() => loading),
    };
    const windowAddEventListener = vi.fn();
    const windowRemoveEventListener = vi.fn();
    const documentAddEventListener = vi.fn();
    const documentRemoveEventListener = vi.fn();
    const storage = new Map<string, string>();
    const sessionStorage = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value); },
      removeItem: (key: string) => { storage.delete(key); },
    };
    const pageUrl = `https://game.example/play#${new URLSearchParams({
      rgsLaunchCode: LAUNCH_CODE,
      rgsOperatorId: "operator-a",
      rgsSessionId: "session-a",
    })}`;
    const browserWindow = {
      location: { href: pageUrl },
      history: { state: null, replaceState: vi.fn() },
      navigator: { onLine: true },
      sessionStorage,
      addEventListener: windowAddEventListener,
      removeEventListener: windowRemoveEventListener,
      parent: null as unknown,
    };
    browserWindow.parent = browserWindow;

    vi.stubGlobal("window", browserWindow);
    vi.stubGlobal("document", {
      visibilityState: "visible",
      querySelector: vi.fn(() => root),
      createElement: vi.fn(() => ({ getContext: () => null })),
      addEventListener: documentAddEventListener,
      removeEventListener: documentRemoveEventListener,
    });
    vi.stubGlobal("fetch", vi.fn());
    try {
      const { startApplication } = await import("../src/main");
      startApplication(pageUrl);

      await vi.waitFor(() => expect(createApplication).toHaveBeenCalledOnce());
      await vi.waitFor(() => expect(status.textContent).toBe(
        "The game could not start. Please try again.",
      ));

      expect(status.textContent).not.toContain(assemblyFailure.message);
      expect(windowAddEventListener.mock.calls.map(([type]) => type)).toEqual([
        "online",
        "offline",
        "pageshow",
        "pagehide",
        "error",
        "unhandledrejection",
      ]);
      expect(windowRemoveEventListener.mock.calls.map(([type]) => type)).toEqual([
        "online",
        "offline",
        "pageshow",
        "pagehide",
        "error",
        "unhandledrejection",
      ]);
      expect(documentAddEventListener).toHaveBeenCalledWith(
        "visibilitychange",
        expect.any(Function),
      );
      expect(documentRemoveEventListener).toHaveBeenCalledWith(
        "visibilitychange",
        expect.any(Function),
      );
    } finally {
      vi.doUnmock("../src/app/AppController");
      vi.doUnmock("../src/startup/frameSlicedInitialization");
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it.each(["error", "unhandledrejection"] as const)(
    "fails closed once on a runtime %s without leaking or repeating an economic request",
    async (firstEventType) => {
    vi.resetModules();
    vi.stubEnv("VITE_RGS_HOST_ORIGIN", "https://operator.example");
    const gatewayClose = vi.fn(() => { throw new Error("gateway close observer failed"); });
    const economicRequest = vi.fn((_roundId: string, _betMinor: string) => true);
    const gateway = {
      operatorHostOrigin: "https://operator.example",
      setRuntimeAvailability: vi.fn(),
      close: gatewayClose,
      requestSpin: economicRequest,
    };
    const appStart = vi.fn();
    const appDestroy = vi.fn(() => { throw new Error("view teardown failed"); });
    const createApplication = vi.fn(async () => ({
      start: appStart,
      destroy: appDestroy,
    }));
    vi.doMock("../src/protocol/configuredGateway", () => ({
      createConfiguredGameGateway: vi.fn(() => gateway),
      optionalWindowSessionStorage: vi.fn((windowValue: Window) => windowValue.sessionStorage),
    }));
    vi.doMock("../src/app/AppController", () => ({
      AppController: { create: createApplication },
    }));
    vi.doMock("../src/startup/frameSlicedInitialization", () => ({
      waitForPaintedFrame: vi.fn(() => Promise.resolve()),
    }));
    vi.doMock("../src/startup/configurePixiContentSecurityPolicy", () => ({
      configurePixiContentSecurityPolicy: vi.fn(),
    }));
    vi.doMock("../src/renderer/configurePixiTextMetricsReadbackCanvas", () => ({
      configurePixiTextMetricsReadbackCanvas: vi.fn(),
    }));

    const sensitiveMessage = `token=${"s".repeat(64)} https://rgs.example/private?launch=secret`;
    const status = { textContent: "Game ready" };
    const loading = {
      dataset: {} as Record<string, string>,
      querySelector: vi.fn(() => status),
      setAttribute: vi.fn(),
      removeAttribute: vi.fn(),
    };
    const root = {
      dataset: {} as Record<string, string>,
      querySelector: vi.fn((selector: string) => (
        selector === '[data-role="launch-loading"]' ? loading : null
      )),
    };
    const listeners = new Map<string, Set<EventListener>>();
    const windowAddEventListener = vi.fn((type: string, listener: EventListener) => {
      const bucket = listeners.get(type) ?? new Set<EventListener>();
      bucket.add(listener);
      listeners.set(type, bucket);
    });
    const windowRemoveEventListener = vi.fn((type: string, listener: EventListener) => {
      listeners.get(type)?.delete(listener);
    });
    const dispatched: unknown[] = [];
    const dispatchEvent = vi.fn((event: { readonly type: string }) => {
      dispatched.push(event);
      for (const listener of [...(listeners.get(event.type) ?? [])]) {
        listener.call(browserWindow as unknown as Window, event as Event);
      }
      return true;
    });
    const pendingLedger = JSON.stringify({
      version: 2,
      roundId: "round-pending",
      betMinor: "100",
    });
    const storage = new Map([["slots-game:rgs-round-ledger:v1", pendingLedger]]);
    const sessionStorage = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value); },
      removeItem: (key: string) => { storage.delete(key); },
    };
    const postMessage = vi.fn();
    const browserWindow = {
      location: { href: "https://game.example/play" },
      history: { state: null, replaceState: vi.fn() },
      navigator: { onLine: true },
      sessionStorage,
      addEventListener: windowAddEventListener,
      removeEventListener: windowRemoveEventListener,
      dispatchEvent,
      parent: { postMessage },
    };
    const documentAddEventListener = vi.fn();
    const documentRemoveEventListener = vi.fn();
    vi.stubGlobal("window", browserWindow);
    vi.stubGlobal("document", {
      visibilityState: "visible",
      querySelector: vi.fn(() => root),
      addEventListener: documentAddEventListener,
      removeEventListener: documentRemoveEventListener,
    });
    vi.stubGlobal("CustomEvent", TestCustomEvent);
    try {
      const { startApplication } = await import("../src/main");
      startApplication("https://game.example/play");
      await vi.waitFor(() => expect(appStart).toHaveBeenCalledOnce());

      // 代表异常前已接受的一次经济请求；故障边界只能终止，绝不能重提。 / English: Represents an economic request that has been accepted before the exception; the fault boundary can only be terminated and must not be repeated.
      expect(gateway.requestSpin("round-pending", "100")).toBe(true);
      const firstPreventDefault = vi.fn(() => { throw new Error("event cancellation failed"); });
      const firstEvent = firstEventType === "error"
        ? {
            type: "error",
            error: new Error(sensitiveMessage),
            message: sensitiveMessage,
            preventDefault: firstPreventDefault,
          }
        : {
            type: "unhandledrejection",
            reason: new Error(sensitiveMessage),
            preventDefault: firstPreventDefault,
          };
      expect(() => dispatchEvent(firstEvent)).not.toThrow();
      const secondPreventDefault = vi.fn();
      const secondEvent = firstEventType === "error"
        ? {
            type: "unhandledrejection",
            reason: new Error(sensitiveMessage),
            preventDefault: secondPreventDefault,
          }
        : {
            type: "error",
            error: new Error(sensitiveMessage),
            message: sensitiveMessage,
            preventDefault: secondPreventDefault,
          };
      expect(() => dispatchEvent(secondEvent)).not.toThrow();

      expect(firstPreventDefault).toHaveBeenCalledOnce();
      expect(secondPreventDefault).not.toHaveBeenCalled();
      expect(appDestroy).toHaveBeenCalledOnce();
      expect(gatewayClose).toHaveBeenCalledOnce();
      expect(economicRequest).toHaveBeenCalledOnce();
      expect(storage.get("slots-game:rgs-round-ledger:v1")).toBe(pendingLedger);
      expect(root.dataset.runtimeFailure).toBe("operator-session-required");
      expect(loading.dataset).toMatchObject({
        visible: "true",
        stage: "runtime-failed",
      });
      expect(loading.setAttribute).toHaveBeenCalledWith("aria-hidden", "false");
      expect(status.textContent).toBe(
        "This game session is unavailable. Return to your operator and start a new session.",
      );
      expect(status.textContent).not.toContain(sensitiveMessage);
      expect(JSON.stringify(dispatched.filter((event) => (
        (event as { readonly type?: string }).type === OPERATOR_SESSION_REQUIRED_EVENT
      )))).not.toContain(sensitiveMessage);
      expect(postMessage).toHaveBeenCalledOnce();
      expect(postMessage).toHaveBeenCalledWith({
        type: OPERATOR_SESSION_REQUIRED_EVENT,
        version: 1,
        reason: "committed-result-recovery-required",
        code: PLAYER_FACING_ERROR_CODES.OPERATOR_SESSION_REQUIRED,
      }, "https://operator.example");
      expect(listeners.get("error")).toEqual(new Set());
      expect(listeners.get("unhandledrejection")).toEqual(new Set());
      expect(windowRemoveEventListener).toHaveBeenCalledWith("error", expect.any(Function));
      expect(windowRemoveEventListener).toHaveBeenCalledWith(
        "unhandledrejection",
        expect.any(Function),
      );
      expect(documentRemoveEventListener).toHaveBeenCalledWith(
        "visibilitychange",
        expect.any(Function),
      );
    } finally {
      vi.doUnmock("../src/protocol/configuredGateway");
      vi.doUnmock("../src/app/AppController");
      vi.doUnmock("../src/startup/frameSlicedInitialization");
      vi.doUnmock("../src/startup/configurePixiContentSecurityPolicy");
      vi.doUnmock("../src/renderer/configurePixiTextMetricsReadbackCanvas");
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      vi.resetModules();
    }
    },
  );
});
