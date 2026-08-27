// @ts-nocheck -- 源码契约与模块装配测试需要 Node 文件 API 和可控浏览器桩。
import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

const LAUNCH_CODE = `lc_${"b".repeat(43)}`;

afterEach(() => {
  vi.doUnmock("../src/main");
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("minimal launch bootstrap", () => {
  it("is the sole HTML entry and has no static application dependency graph", () => {
    const indexHtml = source("../index.html");
    const bootstrap = source("../src/bootstrap.ts");
    const main = source("../src/main.ts");
    const preflight = source("../public/browser-preflight.js");

    expect(indexHtml).toContain('src="/src/bootstrap.ts"');
    expect(indexHtml).not.toContain('src="/src/main.ts"');
    expect(indexHtml.indexOf('id="launch-fragment-scrub"'))
      .toBeLessThan(indexHtml.indexOf('src="%BASE_URL%browser-preflight.js"'));
    expect(indexHtml.indexOf('src="%BASE_URL%browser-preflight.js"'))
      .toBeLessThan(indexHtml.indexOf('src="/src/bootstrap.ts"'));
    expect(bootstrap).not.toMatch(/^\s*import(?:\s|["'])/m);
    expect(bootstrap).not.toMatch(/pixi|AppController|configuredGateway|sessionStorage|localStorage/i);
    expect(bootstrap).not.toMatch(/\.get(?:All)?\(/);
    expect(bootstrap.indexOf("burnEarlyLaunchHandoff(window)"))
      .toBeLessThan(bootstrap.indexOf("scrubLaunchFragment(window)"));
    expect(bootstrap.indexOf("scrubLaunchFragment(window)"))
      .toBeLessThan(bootstrap.indexOf('import("./main")'));
    expect(bootstrap).toContain("if (import.meta.env.PROD)");
    expect(bootstrap).toContain('Promise.reject(new Error("Browser preflight state is missing"))');
    expect(bootstrap).not.toContain("console.");
    expect(preflight).toContain("if (!scrubFallbackLaunchFragment()) return;");
    expect(preflight.indexOf("if (!scrubFallbackLaunchFragment()) return;"))
      .toBeLessThan(preflight.indexOf("presentBootstrapFailure();"));
    expect(preflight).not.toContain("window.location.href");
    expect(main).toContain("export function startApplication(");
    expect(main).toContain("pageUrl: launchPageUrl");
    expect(main.indexOf('document.querySelector<HTMLElement>("#app")'))
      .toBeGreaterThan(main.indexOf("export function startApplication("));
  });

  it("does not reread location or load the application after preflight fixed failure", async () => {
    const mainModuleFactory = vi.fn(() => ({ startApplication: vi.fn() }));
    const takeLaunchHandoff = vi.fn(() => null);
    const windowValue = { parent: null };
    windowValue.parent = windowValue;
    Object.defineProperty(windowValue, "location", {
      configurable: false,
      get: () => { throw new Error("fixed-failure bootstrap reread location"); },
    });
    Object.defineProperty(windowValue, "__slotsBrowserPreflight", {
      configurable: false,
      enumerable: false,
      writable: false,
      value: Object.freeze({
        schema: 1,
        supported: false,
        hadLaunchHandoff: false,
        takeLaunchHandoff,
      }),
    });
    vi.stubGlobal("window", windowValue);
    vi.stubGlobal("document", { querySelector: vi.fn(() => null) });
    vi.doMock("../src/main", mainModuleFactory);

    const bootstrap = await import("../src/bootstrap");
    await expect(bootstrap.applicationBootstrap).resolves.toBeUndefined();

    expect(takeLaunchHandoff).not.toHaveBeenCalled();
    expect(mainModuleFactory).not.toHaveBeenCalled();
  });

  it("immediately burns the inline handoff when the external preflight is missing", async () => {
    const sanitizedUrl = "https://game.example/play?channel=desktop#view=mobile";
    const take = vi.fn(() => Object.freeze({
      schema: 1,
      pageUrl: `https://game.example/play#rgsLaunchCode=${LAUNCH_CODE}`,
      hadLaunchHandoff: true,
    }));
    const startApplication = vi.fn();
    const windowValue = {
      location: { href: sanitizedUrl },
      history: { state: null, replaceState: vi.fn() },
      parent: null,
    };
    windowValue.parent = windowValue;
    Object.defineProperty(windowValue, "__slotsEarlyLaunchHandoff", {
      configurable: false,
      enumerable: false,
      writable: false,
      value: Object.freeze({ schema: 1, hadLaunchHandoff: true, take }),
    });
    vi.stubGlobal("window", windowValue);
    vi.stubGlobal("document", { querySelector: vi.fn(() => null) });
    vi.doMock("../src/main", () => ({ startApplication }));

    const bootstrap = await import("../src/bootstrap");
    await expect(bootstrap.applicationBootstrap).resolves.toBeUndefined();

    expect(take).toHaveBeenCalledOnce();
    expect(startApplication).toHaveBeenCalledOnce();
    expect(startApplication).toHaveBeenCalledWith(sanitizedUrl);
    expect(JSON.stringify(startApplication.mock.calls)).not.toContain(LAUNCH_CODE);
  });

  it("scrubs every launch key before a downstream chunk failure and never renders the raw error", async () => {
    const originalUrl = `https://game.example/play#${new URLSearchParams({
      view: "mobile",
      rgsLaunchCode: LAUNCH_CODE,
      rgsOperatorId: "operator-a",
      rgsSessionId: "session-a",
    })}&rgsLaunchCode=${LAUNCH_CODE}`;
    const replaceState = vi.fn();
    const postMessage = vi.fn();
    const status = { textContent: "Loading game resources" };
    const loading = {
      dataset: {},
      querySelector: vi.fn(() => status),
      removeAttribute: vi.fn(),
      setAttribute: vi.fn(),
    };
    const root = { dataset: {}, querySelector: vi.fn(() => loading) };
    vi.stubGlobal("window", {
      location: { href: originalUrl },
      history: { state: null, replaceState },
      parent: { postMessage },
    });
    vi.stubEnv("VITE_RGS_HOST_ORIGIN", "https://operator.example");
    vi.stubGlobal("document", { querySelector: vi.fn(() => root) });
    vi.doMock("../src/main", () => {
      throw new Error("chunk failed");
    });

    const bootstrap = await import("../src/bootstrap");
    await expect(bootstrap.applicationBootstrap).rejects.toBeDefined();

    expect(replaceState).toHaveBeenCalledOnce();
    const replacement = String(replaceState.mock.calls[0]?.[2]);
    expect(replacement).toContain("#view=mobile");
    expect(replacement).not.toContain("rgsLaunchCode");
    expect(replacement).not.toContain(LAUNCH_CODE);
    expect(replacement).not.toContain("rgsOperatorId");
    expect(replacement).not.toContain("rgsSessionId");
    expect(status.textContent).toBe("The game could not start. Please try again.");
    expect(root.dataset.browserCompatibility).toBe("bootstrap-failed");
    expect(loading.dataset).toMatchObject({
      stage: "bootstrap-failed",
      visible: "true",
    });
    expect(status.textContent).not.toContain(originalUrl);
    expect(postMessage).toHaveBeenCalledWith({
      type: "slots-game:operator-session-required",
      version: 1,
      reason: "initial-session-failed",
      code: "OPERATOR_SESSION_REQUIRED",
    }, "https://operator.example");
    expect(JSON.stringify(postMessage.mock.calls[0]?.[0])).not.toContain(originalUrl);
  });

  it("scrubs before application startup throws for a missing root and hands off only the opaque URL", async () => {
    const originalUrl = `https://game.example/play#rgsLaunchCode=${LAUNCH_CODE}`;
    const replaceState = vi.fn();
    const postMessage = vi.fn();
    const startApplication = vi.fn(() => { throw new Error("Application root is missing"); });
    vi.stubGlobal("window", {
      location: { href: originalUrl },
      history: { state: null, replaceState },
      parent: { postMessage },
    });
    vi.stubEnv("VITE_RGS_HOST_ORIGIN", "https://operator.example");
    vi.stubGlobal("document", { querySelector: vi.fn(() => null) });
    vi.doMock("../src/main", () => ({ startApplication }));

    const bootstrap = await import("../src/bootstrap");
    await expect(bootstrap.applicationBootstrap).rejects.toThrow("Application root is missing");

    expect(replaceState).toHaveBeenCalledOnce();
    expect(String(replaceState.mock.calls[0]?.[2])).not.toContain(LAUNCH_CODE);
    expect(startApplication).toHaveBeenCalledOnce();
    expect(startApplication).toHaveBeenCalledWith(originalUrl);
    expect(postMessage).toHaveBeenCalledWith({
      type: "slots-game:operator-session-required",
      version: 1,
      reason: "initial-session-failed",
      code: "OPERATOR_SESSION_REQUIRED",
    }, "https://operator.example");
  });

  it.each([
    "*",
    "http://operator.example",
    "https://operator.example/",
    "https://operator.example/path",
  ])("never posts bootstrap recovery to an invalid target origin: %s", async (origin) => {
    const postMessage = vi.fn();
    vi.stubEnv("VITE_RGS_HOST_ORIGIN", origin);
    vi.stubGlobal("window", {
      location: { href: `https://game.example/#rgsLaunchCode=${LAUNCH_CODE}` },
      history: { state: null, replaceState: vi.fn() },
      parent: { postMessage },
    });
    vi.stubGlobal("document", { querySelector: vi.fn(() => null) });
    vi.doMock("../src/main", () => { throw new Error("chunk failed"); });

    const bootstrap = await import("../src/bootstrap");
    await expect(bootstrap.applicationBootstrap).rejects.toBeDefined();

    expect(postMessage).not.toHaveBeenCalled();
  });

  it("navigates to the sanitized URL and never imports main when history replacement is blocked", async () => {
    const originalUrl = `https://game.example/play#${new URLSearchParams({
      view: "mobile",
      rgsLaunchCode: LAUNCH_CODE,
      rgsOperatorId: "operator-a",
      rgsSessionId: "session-a",
    })}`;
    const locationReplace = vi.fn();
    const startApplication = vi.fn();
    const mainModuleFactory = vi.fn(() => ({ startApplication }));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubGlobal("window", {
      location: { href: originalUrl, replace: locationReplace },
      history: {
        state: null,
        replaceState: vi.fn(() => { throw new DOMException("sandbox blocked", "SecurityError"); }),
      },
    });
    vi.stubGlobal("document", { querySelector: vi.fn(() => null) });
    vi.doMock("../src/main", mainModuleFactory);
    try {
      await expect(import("../src/bootstrap")).rejects.toThrow(
        "Launch fragment sanitization navigation requested",
      );

      expect(locationReplace).toHaveBeenCalledOnce();
      const replacement = String(locationReplace.mock.calls[0]?.[0]);
      expect(replacement).toContain("#view=mobile");
      expect(replacement).not.toContain("rgsLaunchCode");
      expect(replacement).not.toContain(LAUNCH_CODE);
      expect(replacement).not.toContain("rgsOperatorId");
      expect(replacement).not.toContain("rgsSessionId");
      expect(mainModuleFactory).not.toHaveBeenCalled();
      expect(startApplication).not.toHaveBeenCalled();
      expect(JSON.stringify(consoleError.mock.calls)).not.toContain(originalUrl);
      expect(JSON.stringify(consoleWarn.mock.calls)).not.toContain(originalUrl);
    } finally {
      consoleError.mockRestore();
      consoleWarn.mockRestore();
    }
  });
});
