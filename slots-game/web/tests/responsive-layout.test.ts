import { describe, expect, it, vi } from "vitest";
import {
  DESKTOP_SPIN_VISIBLE_SIZE,
  DESKTOP_UTILITY_VISIBLE_SIZE,
  MOBILE_BASE_LAYOUTS,
  MOBILE_FPS_LAYOUTS,
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

describe("responsive game viewport", () => {
  it("starts idempotently without applying twice or installing a second observer", () => {
    const observers = installRecordedResizeObservers();
    const fixture = responsiveLayoutLifecycleFixture();
    try {
      const layout = new ResponsiveLayout(fixture.viewport, fixture.frame, fixture.onLayout);

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

  it("invalidates a saved or already-queued ResizeObserver callback when stopped", () => {
    const observers = installRecordedResizeObservers();
    const fixture = responsiveLayoutLifecycleFixture();
    try {
      const layout = new ResponsiveLayout(fixture.viewport, fixture.frame, fixture.onLayout);
      layout.start();
      const firstObserver = observers[0];
      expect(firstObserver).toBeDefined();

      layout.stop();
      expect(firstObserver?.disconnect).toHaveBeenCalledOnce();
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
    try {
      const layout = new ResponsiveLayout(fixture.viewport, fixture.frame, fixture.onLayout);
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
      expect(fixture.onLayout).toHaveBeenCalledTimes(2);

      secondObserver?.callback([], secondObserver as unknown as ResizeObserver);
      expect(fixture.onLayout).toHaveBeenCalledTimes(3);
      expect(fixture.onLayout.mock.calls.at(-1)?.[0].viewportRegion).toEqual({
        left: 0,
        top: 0,
        width: 844,
        height: 390,
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
    try {
      const layout = new ResponsiveLayout(fixture.viewport, fixture.frame, fixture.onLayout);
      layout.start();
      layout.start();
      expect(addEventListener).toHaveBeenCalledOnce();
      expect(resizeHandlers).toHaveLength(1);

      const staleResize = resizeHandlers[0];
      layout.stop();
      expect(removeEventListener).toHaveBeenCalledWith("resize", staleResize);
      fixture.onLayout.mockClear();
      staleResize?.();
      expect(fixture.onLayout).not.toHaveBeenCalled();

      layout.start();
      expect(addEventListener).toHaveBeenCalledTimes(2);
      expect(resizeHandlers).toHaveLength(2);
      staleResize?.();
      expect(fixture.onLayout).toHaveBeenCalledOnce();
      resizeHandlers[1]?.();
      expect(fixture.onLayout).toHaveBeenCalledTimes(2);
      layout.stop();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("freezes the launch channel across repeated DevTools device-mode viewport changes", () => {
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
    try {
      const layout = new ResponsiveLayout(viewport, frame, (snapshot) => snapshots.push(snapshot));
      layout.start();
      expect(snapshots.at(-1)?.channel).toBe("desktop");

      coarsePointer = true;
      Object.assign(viewport, { clientWidth: 390, clientHeight: 844 });
      resize();
      expect(snapshots.at(-1)?.channel).toBe("desktop");
      expect(frame.dataset.channel).toBe("desktop");
      expect(style.width).toBe("1280px");
      expect(style.height).toBe("720px");
      expect(style.left).toBe("-65px");
      expect(style.top).toBe("275.75px");

      coarsePointer = false;
      Object.assign(viewport, { clientWidth: 1_280, clientHeight: 720 });
      resize();
      resize();
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
  it("fills a 1440×900 desktop viewport and crops the renderer symmetrically", () => {
    expect(computeResponsiveFrameGeometry(1_440, 900)).toEqual({
      x: -80,
      y: 0,
      width: 1_600,
      height: 900,
      scale: 1.25,
      visibleInsetX: 64,
    });
  });

  it("centres a 768×576 game surface in a 768×900 tablet viewport", () => {
    expect(computeResponsiveFrameGeometry(768, 900)).toEqual({
      x: -128,
      y: 162,
      width: 1_024,
      height: 576,
      scale: 0.8,
      visibleInsetX: 160,
    });
  });

  it("centres the 292.5px game surface in a 390×844 phone viewport", () => {
    const geometry = computeResponsiveFrameGeometry(390, 844);
    expect(geometry).toEqual({
      x: -65,
      y: 275.75,
      width: 520,
      height: 292.5,
      scale: 0.40625,
      visibleInsetX: 160,
    });
    expect(responsiveFrameStyles(geometry)).toEqual({
      left: "-65px",
      top: "275.75px",
      transform: "scale(0.40625)",
      transformOrigin: "top left",
    });
    expect(responsiveCompositionScale(geometry)).toBeCloseTo(960 / 1_100, 10);
  });

  it("covers the exact tablet and mobile-landscape regression viewports", () => {
    const tablet = computeResponsiveFrameGeometry(1_024, 768);
    expect(tablet.x).toBeCloseTo(-170.6666666667, 10);
    expect(tablet.y).toBe(0);
    expect(tablet.width).toBeCloseTo(1_365.3333333333, 10);
    expect(tablet.height).toBe(768);
    expect(tablet.scale).toBeCloseTo(1.0666666667, 10);
    expect(tablet.visibleInsetX).toBeCloseTo(160, 10);

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
      computeResponsiveFrameGeometry(1_440, 900),
    )).toBeCloseTo(1_152 / 1_100, 10);
    expect(responsiveCompositionScale(
      computeResponsiveFrameGeometry(768, 900),
    )).toBeCloseTo(960 / 1_100, 10);
  });

  it("collapses safely when dimensions are invalid", () => {
    expect(computeResponsiveFrameGeometry(Number.NaN, 844)).toEqual({
      x: 0,
      y: 422,
      width: 0,
      height: 0,
      scale: 0,
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
    expect(portrait.spinHitPhysicalSize).toBeCloseTo(39.78, 10);
    expect(portrait.spinHitLogicalSize).toBeCloseTo(97.92, 10);

    const landscape = responsiveControlGeometry(844, 390, 390 / 720);
    expect(landscape.utilityVisiblePhysicalSize).toBeCloseTo(18.9583333333, 10);
    expect(landscape.utilityHitPhysicalSize).toBeCloseTo(60.768, 10);
    expect(landscape.utilityHitLogicalSize).toBeCloseTo(112.1870769231, 10);
    expect(landscape.spinVisiblePhysicalSize).toBeCloseTo(52.5416666667, 10);
    expect(landscape.spinHitPhysicalSize).toBeCloseTo(86.088, 10);
    expect(landscape.spinHitLogicalSize).toBeCloseTo(158.9316923077, 10);
  });

  it("keeps the channel-aware snapshot on the existing desktop projection by default", () => {
    const snapshot = computeResponsiveLayoutSnapshot(390, 844);

    expect(snapshot.channel).toBe("desktop");
    expect(snapshot.handMode).toBe("right");
    expect(snapshot.desktopFrame).toEqual(computeResponsiveFrameGeometry(390, 844));
    expect(snapshot.gameplayRegion).toEqual({ left: 0, top: 0, width: 390, height: 844 });
    expect(snapshot.statusRegion).toEqual({ left: 0, top: 844, width: 390, height: 0 });
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
    expect(tablet.gameplayRegion).toEqual({ left: 0, top: 0, width: 1_024, height: 732 });
    expect(tablet.statusRegion).toEqual({ left: 0, top: 732, width: 1_024, height: 36 });
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
    expect(snapshot.statusRegion.height).toBe(77);
  });
});
