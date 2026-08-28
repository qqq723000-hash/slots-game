// @ts-nocheck -- 该测试在隔离 VM 中执行 ES5 经典脚本，不进入浏览器类型域。
import { readFile } from "node:fs/promises";
import vm from "node:vm";

import { describe, expect, it, vi } from "vitest";

const preflightSourceUrl = new URL("../public/browser-preflight.js", import.meta.url);
const indexSourceUrl = new URL("../index.html", import.meta.url);

async function reviewedInlineScrubSource(): Promise<string> {
  const indexSource = await readFile(indexSourceUrl, "utf8");
  const match = indexSource.match(
    /<script id="launch-fragment-scrub">([\s\S]*?)<\/script>/u,
  );
  if (!match) throw new Error("reviewed launch fragment scrub is missing");
  return match[1];
}

async function executePreflight({
  appMounted = true,
  inlineEnabled = true,
  invalidEarlyState = false,
  replaceStateFailure = false,
  supported = true,
} = {}) {
  const [inlineSource, preflightSource] = await Promise.all([
    reviewedInlineScrubSource(),
    readFile(preflightSourceUrl, "utf8"),
  ]);
  const listeners = new Map<string, Array<(event: unknown) => void>>();
  const addEventListener = vi.fn((name: string, listener: (event: unknown) => void) => {
    listeners.set(name, [...(listeners.get(name) ?? []), listener]);
  });
  const removeEventListener = vi.fn((name: string, listener: (event: unknown) => void) => {
    listeners.set(name, (listeners.get(name) ?? []).filter((value) => value !== listener));
  });
  const dispatchEvent = vi.fn((event: { type: string }) => {
    for (const listener of listeners.get(event.type) ?? []) listener(event);
    return true;
  });
  const status = { textContent: "Loading game resources" };
  const loading = {
    querySelector: vi.fn(() => status),
    setAttribute: vi.fn(),
    removeAttribute: vi.fn(),
  };
  const root = {
    querySelector: vi.fn(() => loading),
    setAttribute: vi.fn(),
  };
  let nextTimer = 1;
  const timers = new Map<number, () => void>();
  const setTimeout = vi.fn((callback: () => void) => {
    const handle = nextTimer;
    nextTimer += 1;
    timers.set(handle, callback);
    return handle;
  });
  const clearTimeout = vi.fn((handle: number) => {
    timers.delete(handle);
  });
  const webgl = supported ? {
    MAX_TEXTURE_SIZE: 0x0d33,
    getParameter: vi.fn(() => 16_384),
  } : null;
  let rootMounted = appMounted;
  const document = {
    readyState: "loading",
    addEventListener,
    removeEventListener,
    dispatchEvent,
    createElement: vi.fn(() => ({ getContext: vi.fn(() => webgl) })),
    createEvent: vi.fn(),
    querySelector: vi.fn(() => rootMounted ? root : null),
  };
  const originalUrl = "https://game.example/play?channel=desktop#view=mobile"
    + "&rgsLaunchCode=secret-launch&rgsOperatorId=operator-a&rgsSessionId=session-a";
  const location = {
    href: originalUrl,
    hash: "#view=mobile&rgsLaunchCode=secret-launch&rgsOperatorId=operator-a&rgsSessionId=session-a",
    pathname: "/play",
    search: "?channel=desktop",
    replace: vi.fn(),
  };
  const replaceState = vi.fn((_state: unknown, _unused: string, value: string) => {
    if (replaceStateFailure) throw new Error("history replacement blocked");
    const replacement = new URL(String(value), location.href);
    location.href = replacement.href;
    location.hash = replacement.hash;
    location.pathname = replacement.pathname;
    location.search = replacement.search;
  });
  const window = {
    location,
    history: { state: null, replaceState },
    clearTimeout,
    setTimeout,
  };
  class TestCustomEvent {
    constructor(readonly type: string, readonly init: { detail: unknown }) {}
    get detail() { return this.init.detail; }
  }
  const context = {
    AbortController,
    Array,
    AudioContext: class {},
    BigInt,
    CSS: { supports: vi.fn(() => supported) },
    CustomEvent: TestCustomEvent,
    MutationObserver: class {},
    Number,
    Object,
    Promise,
    String,
    TextDecoder,
    TextEncoder,
    URL,
    URLSearchParams,
    crypto: {
      getRandomValues: vi.fn(),
      subtle: { digest: vi.fn() },
    },
    decodeURIComponent,
    document,
    fetch: vi.fn(),
    queueMicrotask,
    requestAnimationFrame: vi.fn(),
    window,
  };
  if (inlineEnabled) {
    vm.runInNewContext(inlineSource, context, { filename: "launch-fragment-scrub.js" });
  } else if (invalidEarlyState) {
    Object.defineProperty(window, "__slotsEarlyLaunchHandoff", {
      configurable: false,
      enumerable: false,
      writable: false,
      value: Object.freeze({
        schema: 2,
        hadLaunchHandoff: true,
        take: vi.fn(),
      }),
    });
  }
  vm.runInNewContext(preflightSource, context, { filename: "browser-preflight.js" });
  return {
    document,
    listeners,
    loading,
    mountApp: () => { rootMounted = true; },
    originalUrl,
    replaceState,
    locationReplace: location.replace,
    root,
    inlineSource,
    preflightSource,
    status,
    runTimers: () => {
      const callbacks = [...timers.values()];
      timers.clear();
      for (const callback of callbacks) callback();
    },
    timerCount: () => timers.size,
    window,
  };
}

describe("classic browser preflight", () => {
  it("uses ES5 syntax and runs before the production module", async () => {
    const { inlineSource, preflightSource } = await executePreflight();
    expect(inlineSource).not.toMatch(/\b(?:const|let|class)\b|=>|\?\.|`/u);
    expect(preflightSource).not.toMatch(/\b(?:const|let|class)\b|=>|\?\.|`/u);
  });

  it("scrubs launch keys and exposes a non-enumerable one-shot handoff", async () => {
    const fixture = await executePreflight();
    expect(fixture.replaceState).toHaveBeenCalledOnce();
    expect(String(fixture.replaceState.mock.calls[0]?.[2]))
      .toBe("/play?channel=desktop#view=mobile");
    expect(fixture.window.__slotsBrowserPreflight).toEqual({
      schema: 1,
      supported: true,
      hadLaunchHandoff: true,
      takeLaunchHandoff: expect.any(Function),
    });
    expect(Object.getOwnPropertyDescriptor(fixture.window, "__slotsBrowserPreflight"))
      .toMatchObject({ configurable: false, enumerable: false, writable: false });
    expect(Object.getOwnPropertyDescriptor(fixture.window, "__slotsEarlyLaunchHandoff"))
      .toMatchObject({ configurable: false, enumerable: false, writable: false });
    expect(fixture.window.__slotsEarlyLaunchHandoff.take()).toBeNull();
    expect(JSON.stringify(fixture.window.__slotsBrowserPreflight)).not.toContain("secret-launch");
    const delivered = fixture.window.__slotsBrowserPreflight.takeLaunchHandoff();
    expect(delivered).toEqual({
      pageUrl: fixture.originalUrl,
      hadLaunchHandoff: true,
    });
    expect(fixture.window.__slotsBrowserPreflight.takeLaunchHandoff()).toBeNull();
    expect(fixture.timerCount()).toBe(0);
    expect(fixture.listeners.get("DOMContentLoaded") ?? []).toEqual([]);
  });

  it("fails closed with a fixed message when the locked early handoff is absent", async () => {
    const fixture = await executePreflight({ inlineEnabled: false });
    expect(fixture.window.__slotsBrowserPreflight).toEqual({
      schema: 1,
      supported: false,
      hadLaunchHandoff: false,
      takeLaunchHandoff: expect.any(Function),
    });
    expect(fixture.window.__slotsBrowserPreflight.takeLaunchHandoff()).toBeNull();
    expect(fixture.replaceState).toHaveBeenCalledOnce();
    expect(String(fixture.replaceState.mock.calls[0]?.[2]))
      .toBe("/play?channel=desktop#view=mobile");
    expect(fixture.window.location.hash).toBe("#view=mobile");
    expect(fixture.window.location.href).not.toContain("secret-launch");
    expect(fixture.window.location.href).not.toContain("rgsOperatorId");
    expect(fixture.window.location.href).not.toContain("rgsSessionId");
    expect(fixture.root.setAttribute)
      .toHaveBeenCalledWith("data-browser-compatibility", "bootstrap-failed");
    expect(fixture.loading.setAttribute).toHaveBeenCalledWith("data-stage", "bootstrap-failed");
    expect(fixture.status.textContent).toBe("The game could not start. Please try again.");
    expect(fixture.timerCount()).toBe(0);
  });

  it("scrubs before fixed failure when the locked early handoff is invalid", async () => {
    const fixture = await executePreflight({ inlineEnabled: false, invalidEarlyState: true });

    expect(fixture.replaceState).toHaveBeenCalledOnce();
    expect(fixture.window.location.hash).toBe("#view=mobile");
    expect(fixture.window.__slotsBrowserPreflight).toEqual({
      schema: 1,
      supported: false,
      hadLaunchHandoff: false,
      takeLaunchHandoff: expect.any(Function),
    });
    expect(fixture.window.__slotsBrowserPreflight.takeLaunchHandoff()).toBeNull();
    expect(fixture.status.textContent).toBe("The game could not start. Please try again.");
    expect(fixture.timerCount()).toBe(0);
  });

  it("navigates to the sanitized URL and returns when fallback history replacement is blocked", async () => {
    const fixture = await executePreflight({
      inlineEnabled: false,
      replaceStateFailure: true,
    });

    expect(fixture.replaceState).toHaveBeenCalledOnce();
    expect(fixture.locationReplace).toHaveBeenCalledOnce();
    const replacement = String(fixture.locationReplace.mock.calls[0]?.[0]);
    expect(replacement).toBe("/play?channel=desktop#view=mobile");
    expect(replacement).not.toContain("rgsLaunchCode");
    expect(replacement).not.toContain("secret-launch");
    expect(replacement).not.toContain("rgsOperatorId");
    expect(replacement).not.toContain("rgsSessionId");
    expect(fixture.window.__slotsBrowserPreflight).toBeUndefined();
    expect(fixture.root.setAttribute).not.toHaveBeenCalled();
    expect(fixture.status.textContent).toBe("Loading game resources");
    expect(fixture.timerCount()).toBe(0);
  });

  it("scrubs and presents a fixed message without delivering when unsupported", async () => {
    const fixture = await executePreflight({ appMounted: false, supported: false });
    expect(fixture.replaceState).toHaveBeenCalledOnce();
    expect(fixture.window.__slotsBrowserPreflight).toEqual({
      schema: 1,
      supported: false,
      hadLaunchHandoff: true,
      takeLaunchHandoff: expect.any(Function),
    });
    expect(fixture.listeners.get("DOMContentLoaded") ?? []).toHaveLength(1);
    fixture.mountApp();
    for (const listener of fixture.listeners.get("DOMContentLoaded") ?? []) listener({
      type: "DOMContentLoaded",
    });
    expect(fixture.listeners.get("DOMContentLoaded") ?? []).toEqual([]);
    expect(fixture.root.setAttribute)
      .toHaveBeenCalledWith("data-browser-compatibility", "unsupported");
    expect(fixture.loading.setAttribute)
      .toHaveBeenCalledWith("data-stage", "unsupported-browser");
    expect(fixture.status.textContent).toBe(
      "This browser cannot run the game. Update Chrome, Edge, Firefox, or Safari and enable WebGL.",
    );
    expect(fixture.window.__slotsBrowserPreflight.takeLaunchHandoff()).toBeNull();
  });

  it("burns an unclaimed handoff and presents a fixed bootstrap failure after the deadline", async () => {
    const fixture = await executePreflight({ appMounted: false });
    expect(fixture.timerCount()).toBe(1);
    fixture.runTimers();
    expect(fixture.window.__slotsBrowserPreflight.takeLaunchHandoff()).toBeNull();
    expect(fixture.listeners.get("DOMContentLoaded") ?? []).toHaveLength(1);
    fixture.mountApp();
    for (const listener of fixture.listeners.get("DOMContentLoaded") ?? []) listener({
      type: "DOMContentLoaded",
    });
    expect(fixture.root.setAttribute)
      .toHaveBeenCalledWith("data-browser-compatibility", "bootstrap-failed");
    expect(fixture.loading.setAttribute).toHaveBeenCalledWith("data-stage", "bootstrap-failed");
    expect(fixture.status.textContent).toBe("The game could not start. Please try again.");
  });
});
