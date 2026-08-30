import { describe, expect, it, vi } from "vitest";
import {
  DESKTOP_SPIN_VISIBLE_SIZE,
  DESKTOP_UTILITY_VISIBLE_SIZE,
  MOBILE_BASE_LAYOUTS,
  MOBILE_FPS_LAYOUTS,
  computeDesktopFrameGeometry,
  computeResponsiveLayoutSnapshot,
  computeResponsiveFrameGeometry,
  mobileFpsLayoutProfile,
  mobileLayoutProfile,
  resolveResponsiveMinBound,
  responsiveCompositionScale,
  responsiveControlGeometry,
  responsiveFrameStyles,
  responsiveRendererRegion,
  responsiveVisibleInset,
  ResponsiveLayout,
  type ResponsiveLayoutSnapshot,
} from "../src/renderer/ResponsiveLayout";

function responsiveLayoutLifecycleFixture(): {
  readonly viewport: HTMLElement;
  readonly frame: HTMLElement;
  readonly styleSetProperty: ReturnType<typeof vi.fn>;
  readonly onLayout: ReturnType<typeof vi.fn<(snapshot: ResponsiveLayoutSnapshot) => void>>;
} {
  const styleSetProperty = vi.fn();
  const frame = {
    dataset: {},
    style: {
      width: "",
      height: "",
      left: "",
      top: "",
      transform: "",
      transformOrigin: "",
      setProperty: styleSetProperty,
      removeProperty: vi.fn(),
    },
    inert: false,
  } as unknown as HTMLElement;
  const viewport = {
    clientWidth: 1_280,
    clientHeight: 720,
    dataset: {},
    querySelector: () => null,
  } as unknown as HTMLElement;
  return {
    viewport,
    frame,
    styleSetProperty,
    onLayout: vi.fn<(snapshot: ResponsiveLayoutSnapshot) => void>(),
  };
}

function installRecordedResizeObservers(): Array<{
  readonly callback: ResizeObserverCallback;
  readonly observe: ReturnType<typeof vi.fn>;
  readonly disconnect: ReturnType<typeof vi.fn>;
}> {
  const records: Array<{
    readonly callback: ResizeObserverCallback;
    readonly observe: ReturnType<typeof vi.fn>;
    readonly disconnect: ReturnType<typeof vi.fn>;
  }> = [];
  class TestResizeObserver {
    readonly observe = vi.fn();
    readonly unobserve = vi.fn();
    readonly disconnect = vi.fn();

    constructor(readonly callback: ResizeObserverCallback) {
      records.push(this);
    }
  }
  vi.stubGlobal("ResizeObserver", TestResizeObserver);
  vi.stubGlobal("window", {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  return records;
}

function createManualFrameScheduler(): {
  readonly requestFrame: ReturnType<typeof vi.fn<(callback: FrameRequestCallback) => number>>;
  readonly cancelFrame: ReturnType<typeof vi.fn<(handle: number) => void>>;
  readonly pending: () => number;
  readonly flush: () => void;
} {
  let nextHandle = 1;
  const callbacks = new Map<number, FrameRequestCallback>();
  const requestFrame = vi.fn((callback: FrameRequestCallback): number => {
    const handle = nextHandle;
    nextHandle += 1;
    callbacks.set(handle, callback);
    return handle;
  });
  const cancelFrame = vi.fn((handle: number): void => {
    callbacks.delete(handle);
  });
  return {
    requestFrame,
    cancelFrame,
    pending: () => callbacks.size,
    flush: () => {
      const scheduled = [...callbacks.values()];
      callbacks.clear();
      for (const callback of scheduled) callback(0);
    },
  };
}

describe("responsive game viewport", () => {
  it("starts idempotently without applying twice or installing a second observer", () => {
    const observers = installRecordedResizeObservers();
    const fixture = responsiveLayoutLifecycleFixture();
    const frames = createManualFrameScheduler();
    try {
      const layout = new ResponsiveLayout(fixture.viewport, fixture.frame, fixture.onLayout, frames);

      layout.start();
      layout.start();

      expect(observers).toHaveLength(1);
      expect(observers[0]?.observe).toHaveBeenCalledOnce();
      expect(observers[0]?.observe).toHaveBeenCalledWith(fixture.viewport);
      expect(fixture.onLayout).toHaveBeenCalledOnce();
      layout.stop();
      layout.stop();
      expect(observers[0]?.disconnect).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("publishes one shared hand-mode snapshot and preserves it through resize", () => {
    const observers = installRecordedResizeObservers();
    const fixture = responsiveLayoutLifecycleFixture();
    const frames = createManualFrameScheduler();
    Object.assign(fixture.viewport, { clientWidth: 390, clientHeight: 844 });
    try {
      const layout = new ResponsiveLayout(
        fixture.viewport,
        fixture.frame,
        fixture.onLayout,
        { ...frames, channel: "mobile" },
      );

      layout.start();
      expect(fixture.onLayout.mock.calls.at(-1)?.[0].handMode).toBe("right");

      layout.setHandMode("left");
      expect(fixture.onLayout).toHaveBeenCalledTimes(2);
      expect(fixture.onLayout.mock.calls.at(-1)?.[0].handMode).toBe("left");
      expect(fixture.frame.dataset.handMode).toBe("left");

      layout.setHandMode("left");
      expect(fixture.onLayout).toHaveBeenCalledTimes(2);

      Object.assign(fixture.viewport, { clientWidth: 844, clientHeight: 390 });
      observers[0]?.callback([], observers[0] as unknown as ResizeObserver);
      frames.flush();
      expect(fixture.onLayout.mock.calls.at(-1)?.[0]).toMatchObject({
        handMode: "left",
        mobileProfile: "ls",
      });
      layout.stop();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("invalidates a saved or already-queued ResizeObserver callback when stopped", () => {
    const observers = installRecordedResizeObservers();
    const fixture = responsiveLayoutLifecycleFixture();
    const frames = createManualFrameScheduler();
    try {
      const layout = new ResponsiveLayout(fixture.viewport, fixture.frame, fixture.onLayout, frames);
      layout.start();
      const firstObserver = observers[0];
      expect(firstObserver).toBeDefined();

      Object.assign(fixture.viewport, { clientWidth: 390, clientHeight: 844 });
      firstObserver?.callback([], firstObserver as unknown as ResizeObserver);
      expect(frames.pending()).toBe(1);

      layout.stop();
      expect(firstObserver?.disconnect).toHaveBeenCalledOnce();
      expect(frames.cancelFrame).toHaveBeenCalledOnce();
      fixture.onLayout.mockClear();
      fixture.styleSetProperty.mockClear();
      const frameState = JSON.stringify({
        dataset: fixture.frame.dataset,
        style: {
          width: fixture.frame.style.width,
          height: fixture.frame.style.height,
          left: fixture.frame.style.left,
          top: fixture.frame.style.top,
          transform: fixture.frame.style.transform,
        },
      });

      Object.assign(fixture.viewport, { clientWidth: 390, clientHeight: 844 });
      firstObserver?.callback([], firstObserver as unknown as ResizeObserver);
      frames.flush();

      expect(fixture.onLayout).not.toHaveBeenCalled();
      expect(fixture.styleSetProperty).not.toHaveBeenCalled();
      expect(JSON.stringify({
        dataset: fixture.frame.dataset,
        style: {
          width: fixture.frame.style.width,
          height: fixture.frame.style.height,
          left: fixture.frame.style.left,
          top: fixture.frame.style.top,
          transform: fixture.frame.style.transform,
        },
      })).toBe(frameState);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("creates a fresh observer when restarted and keeps the previous generation stale", () => {
    const observers = installRecordedResizeObservers();
    const fixture = responsiveLayoutLifecycleFixture();
    const frames = createManualFrameScheduler();
    try {
      const layout = new ResponsiveLayout(fixture.viewport, fixture.frame, fixture.onLayout, frames);
      layout.start();
      const firstObserver = observers[0];
      layout.stop();

      Object.assign(fixture.viewport, { clientWidth: 844, clientHeight: 390 });
      layout.start();
      const secondObserver = observers[1];
      expect(observers).toHaveLength(2);
      expect(secondObserver).toBeDefined();
      expect(secondObserver).not.toBe(firstObserver);
      expect(fixture.onLayout).toHaveBeenCalledTimes(2);

      firstObserver?.callback([], firstObserver as unknown as ResizeObserver);
      frames.flush();
      expect(fixture.onLayout).toHaveBeenCalledTimes(2);

      Object.assign(fixture.viewport, { clientWidth: 390, clientHeight: 844 });
      secondObserver?.callback([], secondObserver as unknown as ResizeObserver);
      expect(fixture.onLayout).toHaveBeenCalledTimes(2);
      frames.flush();
      expect(fixture.onLayout).toHaveBeenCalledTimes(3);
      expect(fixture.onLayout.mock.calls.at(-1)?.[0].viewportRegion).toEqual({
        left: 0,
        top: 0,
        width: 390,
        height: 844,
      });
      expect(fixture.onLayout.mock.calls.at(-1)?.[0].physicalViewportRegion).toEqual({
        left: 0,
        top: 0,
        width: 390,
        height: 844,
      });
      layout.stop();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("uses the same idempotent generation guard for the window resize fallback", () => {
    const fixture = responsiveLayoutLifecycleFixture();
    const resizeHandlers: Array<() => void> = [];
    const addEventListener = vi.fn((type: string, handler: () => void) => {
      if (type === "resize") resizeHandlers.push(handler);
    });
    const removeEventListener = vi.fn();
    vi.stubGlobal("ResizeObserver", undefined);
    vi.stubGlobal("window", { addEventListener, removeEventListener });
    const frames = createManualFrameScheduler();
    try {
      const layout = new ResponsiveLayout(fixture.viewport, fixture.frame, fixture.onLayout, frames);
      layout.start();
      layout.start();
      expect(addEventListener).toHaveBeenCalledOnce();
      expect(resizeHandlers).toHaveLength(1);
      expect(fixture.onLayout).toHaveBeenCalledOnce();

      Object.assign(fixture.viewport, { clientWidth: 844, clientHeight: 390 });
      resizeHandlers[0]?.();
      resizeHandlers[0]?.();
      expect(frames.pending()).toBe(1);
      expect(fixture.onLayout).toHaveBeenCalledOnce();
      frames.flush();
      expect(fixture.onLayout).toHaveBeenCalledTimes(2);

      const staleResize = resizeHandlers[0];
      layout.stop();
      expect(removeEventListener).toHaveBeenCalledWith("resize", staleResize);
      staleResize?.();
      frames.flush();
      expect(fixture.onLayout).toHaveBeenCalledTimes(2);

      layout.start();
      expect(addEventListener).toHaveBeenCalledTimes(2);
      expect(resizeHandlers).toHaveLength(2);
      expect(fixture.onLayout).toHaveBeenCalledTimes(3);
      staleResize?.();
      frames.flush();
      expect(fixture.onLayout).toHaveBeenCalledTimes(3);
      Object.assign(fixture.viewport, { clientWidth: 390, clientHeight: 844 });
      resizeHandlers[1]?.();
      frames.flush();
      expect(fixture.onLayout).toHaveBeenCalledTimes(4);
      layout.stop();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("coalesces ResizeObserver, window, and visualViewport events and preserves a zero-size snapshot", () => {
    const fixture = responsiveLayoutLifecycleFixture();
    const frames = createManualFrameScheduler();
    let observerCallback: ResizeObserverCallback = () => undefined;
    class TestResizeObserver {
      readonly observe = vi.fn();
      readonly disconnect = vi.fn();
      constructor(callback: ResizeObserverCallback) { observerCallback = callback; }
    }
    const windowResize = vi.fn<(event?: Event) => void>();
    const visualResize = vi.fn<(event?: Event) => void>();
    const addEventListener = vi.fn((type: string, handler: (event?: Event) => void) => {
      if (type === "resize") windowResize.mockImplementation(handler);
    });
    const removeEventListener = vi.fn();
    const visualViewport = {
      addEventListener: vi.fn((type: string, handler: (event?: Event) => void) => {
        if (type === "resize") visualResize.mockImplementation(handler);
      }),
      removeEventListener: vi.fn(),
    };
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    vi.stubGlobal("window", { addEventListener, removeEventListener, visualViewport });
    try {
      const layout = new ResponsiveLayout(
        fixture.viewport,
        fixture.frame,
        fixture.onLayout,
        {
          channel: "mobile",
          requestFrame: frames.requestFrame,
          cancelFrame: frames.cancelFrame,
        },
      );
      layout.start();
      const stableFrame = JSON.stringify({
        dataset: fixture.frame.dataset,
        width: fixture.frame.style.width,
        height: fixture.frame.style.height,
        left: fixture.frame.style.left,
        top: fixture.frame.style.top,
        transform: fixture.frame.style.transform,
      });

      Object.assign(fixture.viewport, { clientWidth: 0, clientHeight: 844 });
      observerCallback([], {} as ResizeObserver);
      windowResize();
      visualResize();
      expect(frames.pending()).toBe(1);
      frames.flush();
      expect(fixture.onLayout).toHaveBeenCalledOnce();
      expect(JSON.stringify({
        dataset: fixture.frame.dataset,
        width: fixture.frame.style.width,
        height: fixture.frame.style.height,
        left: fixture.frame.style.left,
        top: fixture.frame.style.top,
        transform: fixture.frame.style.transform,
      })).toBe(stableFrame);

      Object.assign(fixture.viewport, { clientWidth: 633, clientHeight: 844 });
      observerCallback([], {} as ResizeObserver);
      windowResize();
      visualResize();
      expect(frames.pending()).toBe(1);
      frames.flush();
      expect(fixture.onLayout).toHaveBeenCalledTimes(2);
      expect(fixture.onLayout.mock.calls.at(-1)?.[0].surfaceProfile).toBe("tablet-pt");

      layout.stop();
      expect(removeEventListener).toHaveBeenCalledWith("resize", expect.any(Function));
      expect(visualViewport.removeEventListener).toHaveBeenCalledWith(
        "resize",
        expect.any(Function),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("re-resolves the layout channel across repeated DevTools device-mode viewport changes", () => {
    const properties = new Map<string, string>();
    const style = {
      width: "",
      height: "",
      left: "",
      top: "",
      transform: "",
      transformOrigin: "",
      setProperty: (name: string, value: string) => properties.set(name, value),
      removeProperty: (name: string) => properties.delete(name),
    };
    const frame = {
      dataset: {},
      style,
      inert: false,
    } as unknown as HTMLElement;
    const viewport = {
      clientWidth: 1_280,
      clientHeight: 720,
      dataset: {},
      querySelector: () => null,
    } as unknown as HTMLElement;
    let resize: () => void = () => {
      throw new Error("ResizeObserver callback was not installed");
    };
    class TestResizeObserver {
      constructor(callback: () => void) { resize = callback; }
      observe(): void {}
      disconnect(): void {}
    }
    let coarsePointer = false;
    const matchMedia = vi.fn(() => ({ matches: coarsePointer }));
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    vi.stubGlobal("location", { search: "" });
    vi.stubGlobal("matchMedia", matchMedia);
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    const snapshots: Array<ReturnType<typeof computeResponsiveLayoutSnapshot>> = [];
    const frames = createManualFrameScheduler();
    try {
      const layout = new ResponsiveLayout(
        viewport,
        frame,
        (snapshot) => snapshots.push(snapshot),
        frames,
      );
      layout.start();
      expect(snapshots.at(-1)?.channel).toBe("desktop");

      coarsePointer = true;
      Object.assign(viewport, { clientWidth: 390, clientHeight: 844 });
      resize();
      frames.flush();
      expect(snapshots.at(-1)?.channel).toBe("mobile");
      expect(frame.dataset.channel).toBe("mobile");
      expect(style.width).toBe("390px");
      expect(style.height).toBe("844px");
      expect(style.left).toBe("0px");
      expect(style.top).toBe("0px");
      expect(style.transform).toBe("scale(1)");

      coarsePointer = false;
      Object.assign(viewport, { clientWidth: 1_280, clientHeight: 720 });
      resize();
      resize();
      expect(frames.pending()).toBe(1);
      frames.flush();
      expect(snapshots.at(-1)?.channel).toBe("desktop");
      expect(frame.dataset.channel).toBe("desktop");
      expect(style.left).toBe("0px");
      expect(style.top).toBe("0px");
      expect(style.transform).toBe("scale(1)");
      expect(properties.get("--visible-inset-x")).toBe("0px");
      layout.stop();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps a fine-pointer phone without launcher routing on the desktop authored baseline", () => {
    const fixture = responsiveLayoutLifecycleFixture();
    Object.assign(fixture.viewport, { clientWidth: 390, clientHeight: 844 });
    const frames = createManualFrameScheduler();
    const matchMedia = vi.fn((query: string) => ({
      matches: query === "(pointer: fine)",
    }));
    vi.stubGlobal("ResizeObserver", class {
      observe(): void {}
      disconnect(): void {}
    });
    vi.stubGlobal("location", { search: "" });
    vi.stubGlobal("matchMedia", matchMedia);
    vi.stubGlobal("navigator", { maxTouchPoints: 0 });
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      visualViewport: null,
    });
    try {
      const layout = new ResponsiveLayout(
        fixture.viewport,
        fixture.frame,
        fixture.onLayout,
        frames,
      );
      layout.start();

      const snapshot = fixture.onLayout.mock.calls.at(-1)?.[0];
      expect(snapshot?.channel).toBe("desktop");
      expect(snapshot?.physicalViewportRegion).toEqual({
        left: 0,
        top: 0,
        width: 390,
        height: 844,
      });
      expect(snapshot?.viewportRegion).toEqual({
        left: 0,
        top: 0,
        width: 1_280,
        height: 720,
      });
      expect(fixture.frame.dataset).toMatchObject({
        channel: "desktop",
        designWidth: "1280",
        designHeight: "720",
        frameScale: "0.40625",
      });
      expect(fixture.frame.style.left).toBe("-65px");
      expect(fixture.frame.style.top).toBe("275.75px");
      expect(fixture.frame.style.transform).toBe("scale(0.40625)");
      expect(fixture.styleSetProperty).toHaveBeenCalledWith("--visible-inset-x", "160px");
      expect(matchMedia).toHaveBeenCalledWith("(pointer: coarse)");
      expect(matchMedia).toHaveBeenCalledWith("(pointer: fine)");
      layout.stop();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each([
    {
      name: "phone portrait",
      width: 390,
      height: 844,
      profile: "phone-pt",
      mobileLayout: "pt",
      designWidth: 390,
      designHeight: 844,
      scale: 1,
    },
    {
      name: "phone landscape",
      width: 844,
      height: 390,
      profile: "phone-ls",
      mobileLayout: "ls",
      designWidth: 844,
      designHeight: 390,
      scale: 1,
    },
    {
      name: "tablet portrait",
      width: 768,
      height: 1_024,
      profile: "tablet-pt",
      mobileLayout: "iPad_pt",
      designWidth: 633,
      designHeight: 844,
      scale: 1_024 / 844,
    },
    {
      name: "tablet landscape",
      width: 1_024,
      height: 768,
      profile: "tablet-ls",
      mobileLayout: "ls",
      designWidth: 844,
      designHeight: 633,
      scale: 1_024 / 844,
    },
  ])("commits the explicit mobile launcher route through the real frame transform on $name", ({
    width,
    height,
    profile,
    mobileLayout,
    designWidth,
    designHeight,
    scale,
  }) => {
    const fixture = responsiveLayoutLifecycleFixture();
    Object.assign(fixture.viewport, { clientWidth: width, clientHeight: height });
    const frames = createManualFrameScheduler();
    vi.stubGlobal("ResizeObserver", class {
      observe(): void {}
      disconnect(): void {}
    });
    vi.stubGlobal("location", { search: "?channel=mobile&layout=mobile" });
    vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
      // IAB/DevTools 在手机视口下仍可能保留鼠标级主指针；显式移动路由必须优先。 / English: IAB/DevTools may still retain the mouse-level primary pointer in mobile viewports; explicit mobile routing must take precedence.
      matches: query === "(pointer: fine)",
    })));
    vi.stubGlobal("navigator", { maxTouchPoints: 0 });
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      visualViewport: null,
    });
    try {
      const layout = new ResponsiveLayout(
        fixture.viewport,
        fixture.frame,
        fixture.onLayout,
        frames,
      );
      layout.start();

      const snapshot = fixture.onLayout.mock.calls.at(-1)?.[0];
      expect(snapshot?.channel).toBe("mobile");
      expect(snapshot?.surfaceProfile).toBe(profile);
      expect(snapshot?.mobileProfile).toBe(mobileLayout);
      expect(snapshot?.frame.width).toBeCloseTo(width, 10);
      expect(snapshot?.frame.height).toBeCloseTo(height, 10);
      expect(snapshot?.frame.x).toBeCloseTo(0, 10);
      expect(snapshot?.frame.y).toBeCloseTo(0, 10);
      expect(snapshot?.frame.scale).toBeCloseTo(scale, 12);
      expect(fixture.frame.dataset).toMatchObject({
        channel: "mobile",
        surfaceProfile: profile,
        designWidth: String(designWidth),
        designHeight: String(designHeight),
        mobileLayout,
      });
      expect(fixture.frame.style.width).toBe(`${designWidth}px`);
      expect(fixture.frame.style.height).toBe(`${designHeight}px`);
      expect(fixture.frame.style.transform).toBe(`scale(${scale})`);
      layout.stop();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("fills a 1440×900 desktop surface and crops renderer wings symmetrically", () => {
    expect(computeDesktopFrameGeometry(1_440, 900)).toEqual({
      x: -80,
      y: 0,
      width: 1_600,
      height: 900,
      scale: 1.25,
      designWidth: 1_280,
      designHeight: 720,
      visibleInsetX: 64,
    });
  });

  it("centres a 768×576 game surface in a 768×900 tablet viewport", () => {
    expect(computeResponsiveFrameGeometry(768, 900)).toEqual({
      x: 0,
      y: 234,
      width: 768,
      height: 432,
      scale: 0.6,
      designWidth: 1_280,
      designHeight: 720,
      visibleInsetX: 0,
    });
  });

  it("centres the 292.5px game surface in a 390×844 phone viewport", () => {
    const geometry = computeResponsiveFrameGeometry(390, 844);
    expect(geometry).toEqual({
      x: 0,
      y: 312.3125,
      width: 390,
      height: 219.375,
      scale: 0.3046875,
      designWidth: 1_280,
      designHeight: 720,
      visibleInsetX: 0,
    });
    expect(responsiveFrameStyles(geometry)).toEqual({
      left: "0px",
      top: "312.3125px",
      transform: "scale(0.3046875)",
      transformOrigin: "top left",
    });
    expect(responsiveCompositionScale(geometry)).toBe(1.05);
  });

  it("contains the exact tablet and mobile-landscape regression viewports", () => {
    const tablet = computeResponsiveFrameGeometry(1_024, 768);
    expect(tablet.x).toBe(0);
    expect(tablet.y).toBe(96);
    expect(tablet.width).toBe(1_024);
    expect(tablet.height).toBe(576);
    expect(tablet.scale).toBe(0.8);
    expect(tablet.visibleInsetX).toBe(0);

    const landscape = computeResponsiveFrameGeometry(844, 390);
    expect(landscape.x).toBeCloseTo(75.3333333333, 10);
    expect(landscape.y).toBe(0);
    expect(landscape.width).toBeCloseTo(693.3333333333, 10);
    expect(landscape.height).toBe(390);
    expect(landscape.scale).toBeCloseTo(0.5416666667, 10);
    expect(landscape.visibleInsetX).toBe(0);
  });

  it("adapts the central composition to the visible logical width", () => {
    expect(responsiveCompositionScale(
      computeDesktopFrameGeometry(1_440, 900),
    )).toBeCloseTo(1_152 / 1_100, 10);
    expect(responsiveCompositionScale(
      computeDesktopFrameGeometry(768, 900),
    )).toBeCloseTo(960 / 1_100, 10);
  });

  it("collapses safely when dimensions are invalid", () => {
    expect(computeResponsiveFrameGeometry(Number.NaN, 844)).toEqual({
      x: 0,
      y: 422,
      width: 0,
      height: 0,
      scale: 0,
      designWidth: 1_280,
      designHeight: 720,
      visibleInsetX: 0,
    });
  });

  it("resolves the captured minBound projection inside the visible renderer region", () => {
    expect(responsiveRendererRegion(160)).toEqual({
      left: 160,
      top: 0,
      width: 960,
      height: 720,
    });
    const transform = resolveResponsiveMinBound(
      responsiveRendererRegion(160),
      { left: 460, top: -130, width: 1_260, height: 900 },
    );
    expect(transform.x).toBeCloseTo(-190.4761904762, 10);
    expect(transform.y).toBeCloseTo(116.1904761905, 10);
    expect(transform.scale).toBeCloseTo(0.7619047619, 10);
    expect(responsiveVisibleInset("160px")).toBe(160);
    expect(responsiveVisibleInset("not-a-length")).toBe(0);
  });

  it("keeps visible desktop art fixed while restoring official mobile hit sizes", () => {
    const desktop = responsiveControlGeometry(1_280, 720, 1);
    expect(desktop).toEqual({
      utilityVisiblePhysicalSize: DESKTOP_UTILITY_VISIBLE_SIZE,
      utilityHitPhysicalSize: DESKTOP_UTILITY_VISIBLE_SIZE,
      utilityHitLogicalSize: DESKTOP_UTILITY_VISIBLE_SIZE,
      spinVisiblePhysicalSize: DESKTOP_SPIN_VISIBLE_SIZE,
      spinHitPhysicalSize: DESKTOP_SPIN_VISIBLE_SIZE,
      spinHitLogicalSize: DESKTOP_SPIN_VISIBLE_SIZE,
    });

    const portrait = responsiveControlGeometry(390, 844, 0.40625);
    expect(portrait.utilityVisiblePhysicalSize).toBeCloseTo(14.21875, 10);
    expect(portrait.utilityHitPhysicalSize).toBeCloseTo(50.64, 10);
    expect(portrait.utilityHitLogicalSize).toBeCloseTo(124.6523076923, 10);
    expect(portrait.spinVisiblePhysicalSize).toBeCloseTo(39.40625, 10);
    expect(portrait.spinHitPhysicalSize).toBe(44);
    expect(portrait.spinHitLogicalSize).toBeCloseTo(108.3076923077, 10);

    const landscape = responsiveControlGeometry(844, 390, 390 / 720);
    expect(landscape.utilityVisiblePhysicalSize).toBeCloseTo(18.9583333333, 10);
    expect(landscape.utilityHitPhysicalSize).toBeCloseTo(60.768, 10);
    expect(landscape.utilityHitLogicalSize).toBeCloseTo(112.1870769231, 10);
    expect(landscape.spinVisiblePhysicalSize).toBeCloseTo(52.5416666667, 10);
    expect(landscape.spinHitPhysicalSize).toBeCloseTo(86.088, 10);
    expect(landscape.spinHitLogicalSize).toBeCloseTo(158.9316923077, 10);

    const tabletScale = 1_024 / 844;
    const tabletLandscape = responsiveControlGeometry(1_024, 768, tabletScale, true);
    expect(tabletLandscape.utilityVisiblePhysicalSize).toBeCloseTo(42.4644549763, 10);
    expect(tabletLandscape.utilityHitPhysicalSize).toBeCloseTo(73.728, 10);
    expect(tabletLandscape.utilityHitLogicalSize).toBeCloseTo(60.768, 10);
    expect(tabletLandscape.spinVisiblePhysicalSize).toBeCloseTo(117.6872037915, 10);
    expect(tabletLandscape.spinHitPhysicalSize).toBeCloseTo(117.6872037915, 10);
    expect(tabletLandscape.spinHitLogicalSize).toBe(DESKTOP_SPIN_VISIBLE_SIZE);

    const tabletPortrait = responsiveControlGeometry(768, 1_024, tabletScale, true);
    expect(tabletPortrait.utilityHitPhysicalSize).toBeCloseTo(61.44, 10);
    expect(tabletPortrait.utilityHitLogicalSize).toBeCloseTo(50.64, 10);
    expect(tabletPortrait.spinHitPhysicalSize).toBeCloseTo(117.6872037915, 10);
    expect(tabletPortrait.spinHitLogicalSize).toBe(DESKTOP_SPIN_VISIBLE_SIZE);

    const compact = responsiveControlGeometry(320, 568, 568 / 844, true);
    expect(compact.utilityHitPhysicalSize).toBe(44);
    expect(compact.spinHitPhysicalSize).toBeGreaterThanOrEqual(44);
  });

  it("keeps desktop gameplay in canonical coordinates while projecting the authored viewport", () => {
    const snapshot = computeResponsiveLayoutSnapshot(390, 844);

    expect(snapshot.channel).toBe("desktop");
    expect(snapshot.handMode).toBe("right");
    expect(snapshot.desktopFrame).toEqual(computeDesktopFrameGeometry(390, 844));
    expect(snapshot.physicalViewportRegion).toEqual({ left: 0, top: 0, width: 390, height: 844 });
    expect(snapshot.viewportRegion).toEqual({ left: 0, top: 0, width: 1_280, height: 720 });
    expect(snapshot.gameplayRegion).toEqual({ left: 0, top: 0, width: 1_280, height: 720 });
    expect(snapshot.statusRegion).toEqual({ left: 0, top: 720, width: 1_280, height: 0 });
    expect(snapshot.mobileProfile).toBeNull();
    expect(snapshot.fpsProfile).toBeNull();
    expect(snapshot.mobileTransforms).toBeNull();
    expect(snapshot.fpsTransforms).toBeNull();
  });

  it("routes base-game mobile profiles at the exact captured boundaries", () => {
    expect(mobileLayoutProfile(739, 1_000)).toBe("pt");
    expect(mobileLayoutProfile(740, 1_000)).toBe("iPad_pt");
    expect(mobileLayoutProfile(1_000, 1_000)).toBe("iPad_pt");
    expect(mobileLayoutProfile(1_001, 1_000)).toBe("ls");
  });

  it("routes Feature Preview with its independent official profile rules", () => {
    expect(mobileFpsLayoutProfile(659, 1_000)).toBe("pt");
    expect(mobileFpsLayoutProfile(660, 1_000)).toBe("iPad_pt");
    expect(mobileFpsLayoutProfile(879, 1_000)).toBe("iPad_pt");
    expect(mobileFpsLayoutProfile(880, 1_000)).toBe("iPad_ls");
    expect(mobileFpsLayoutProfile(1_000, 1_000)).toBe("iPad_ls");
    expect(mobileFpsLayoutProfile(1_001, 1_000)).toBe("ls");
  });

  it("builds the official full-height phone snapshot and excludes its status region", () => {
    const snapshot = computeResponsiveLayoutSnapshot(390, 844, {
      channel: "mobile",
      handMode: "left",
    });

    expect(snapshot.channel).toBe("mobile");
    expect(snapshot.handMode).toBe("left");
    expect(snapshot.desktopFrame).toBeNull();
    expect(snapshot.mobileProfile).toBe("pt");
    expect(snapshot.fpsProfile).toBe("pt");
    expect(snapshot.gameplayRegion).toEqual({ left: 0, top: 0, width: 390, height: 760 });
    expect(snapshot.statusRegion).toEqual({ left: 0, top: 760, width: 390, height: 84 });
    expect(snapshot.mobileLayouts).toBe(MOBILE_BASE_LAYOUTS.pt);
    expect(snapshot.fpsLayouts).toBe(MOBILE_FPS_LAYOUTS.pt);

    expect(snapshot.mobileTransforms?.main).toMatchObject({ x: 195 });
    expect(snapshot.mobileTransforms?.main.scale).toBeCloseTo(390 / 1_100, 10);
    expect(snapshot.mobileTransforms?.background).toMatchObject({ x: 195 });
    expect(snapshot.mobileTransforms?.background.y).toBeCloseTo(341.25, 10);
    expect(snapshot.mobileTransforms?.character).toMatchObject({ x: 195, y: 312 });
    expect(snapshot.mobileTransforms?.character.scale).toBeCloseTo(0.52, 10);
    expect(snapshot.mobileTransforms?.logo?.x).toBeCloseTo(-177.6666666667, 10);
    expect(snapshot.mobileTransforms?.logo?.y).toBeCloseTo(537.5, 10);
  });

  it("uses the landscape mobile contract for phone landscape and tablet landscape", () => {
    const phone = computeResponsiveLayoutSnapshot(844, 390, { channel: "mobile" });
    expect(phone.mobileProfile).toBe("ls");
    expect(phone.fpsProfile).toBe("ls");
    expect(phone.gameplayRegion).toEqual({ left: 0, top: 0, width: 844, height: 372 });
    expect(phone.statusRegion).toEqual({ left: 0, top: 372, width: 844, height: 18 });
    expect(phone.mobileTransforms?.main).toMatchObject({ x: 422, y: 186 });
    expect(phone.mobileTransforms?.main.scale).toBeCloseTo(372 / 900, 10);
    expect(phone.mobileTransforms?.logo?.x).toBeCloseTo(-137.64, 10);
    expect(phone.mobileTransforms?.logo?.y).toBeCloseTo(44.64, 10);

    const tablet = computeResponsiveLayoutSnapshot(1_024, 768, { channel: "mobile" });
    expect(tablet.mobileProfile).toBe("ls");
    expect(tablet.surfaceProfile).toBe("tablet-ls");
    expect(tablet.viewportRegion).toEqual({ left: 0, top: 0, width: 844, height: 633 });
    expect(tablet.gameplayRegion).toEqual({ left: 0, top: 0, width: 844, height: 603 });
    expect(tablet.statusRegion).toEqual({ left: 0, top: 603, width: 844, height: 30 });
  });

  it("supports explicit mobile and FPS profile overrides for deterministic hosts", () => {
    const snapshot = computeResponsiveLayoutSnapshot(1_024, 768, {
      channel: "mobile",
      mobileProfile: "iPad_pt",
      fpsProfile: "iPad_ls",
    });

    expect(snapshot.mobileProfile).toBe("iPad_pt");
    expect(snapshot.fpsProfile).toBe("iPad_ls");
    expect(snapshot.mobileLayouts).toBe(MOBILE_BASE_LAYOUTS.iPad_pt);
    expect(snapshot.fpsLayouts).toBe(MOBILE_FPS_LAYOUTS.iPad_ls);
    expect(snapshot.statusRegion.height).toBe(63);
  });

  it("recomputes continuous mobile geometry across DevTools phone/tablet thresholds", () => {
    const phone = computeResponsiveLayoutSnapshot(599, 1_000, { channel: "mobile" });
    const tablet = computeResponsiveLayoutSnapshot(600, 1_000, { channel: "mobile" });

    expect(phone.surfaceProfile).toBe("phone-pt");
    expect(tablet.surfaceProfile).toBe("tablet-pt");
    expect(phone.viewportRegion).toEqual({ left: 0, top: 0, width: 844 * 0.599, height: 844 });
    expect(tablet.viewportRegion).toEqual({ left: 0, top: 0, width: 844 * 0.6, height: 844 });
    expect(phone.mobileProfile).toBe("pt");
    expect(tablet.mobileProfile).toBe("pt");
    expect(phone.frame).toMatchObject({ x: 0, y: 0, width: 599, height: 1_000 });
    expect(tablet.frame).toMatchObject({ x: 0, y: 0, width: 600, height: 1_000 });
  });
});
