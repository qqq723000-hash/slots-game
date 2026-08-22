import { describe, expect, it, vi } from "vitest";
import {
  PixiRenderer,
  resolveInitialRendererSize,
} from "../src/renderer/PixiRenderer";
import { computeResponsiveLayoutSnapshot } from "../src/renderer/ResponsiveLayout";

describe("resolveInitialRendererSize", () => {
  it("keeps the authored desktop framebuffer by default", () => {
    expect(resolveInitialRendererSize()).toEqual({ width: 1280, height: 720 });
  });

  it("accepts each selected canonical mobile/tablet design surface", () => {
    expect(resolveInitialRendererSize({ width: 390, height: 844 }))
      .toEqual({ width: 390, height: 844 });
    expect(resolveInitialRendererSize({ width: 844, height: 390 }))
      .toEqual({ width: 844, height: 390 });
    expect(resolveInitialRendererSize({ width: 633, height: 844 }))
      .toEqual({ width: 633, height: 844 });
    expect(resolveInitialRendererSize({ width: 844, height: 633 }))
      .toEqual({ width: 844, height: 633 });
  });

  it("preserves a continuous fractional mobile design surface until Pixi quantizes the backing store", () => {
    const initialSize = { width: 844 * (393 / 852), height: 844 };

    expect(resolveInitialRendererSize(initialSize)).toEqual(initialSize);
  });

  it("fails safe to authored dimensions for invalid host measurements", () => {
    expect(resolveInitialRendererSize({ width: Number.NaN, height: 0 }))
      .toEqual({ width: 1280, height: 720 });
  });
});

describe("PixiRenderer canonical resize routing", () => {
  it("uses the fixed tablet surface for logical pixels and DPR only for backing resolution", () => {
    const resize = vi.fn();
    const setReelResolution = vi.fn();
    const setAnticipationResolution = vi.fn();
    const setViewportSize = vi.fn();
    const setLayoutTrack = vi.fn();
    const renderer = Object.create(PixiRenderer.prototype) as PixiRenderer;
    const reels = { setPerspectiveCoordinateScale: setReelResolution };
    const anticipation = {
      setPerspectiveCoordinateScale: setAnticipationResolution,
      syncToReelHost: vi.fn(),
    };
    Object.assign(renderer as unknown as Record<string, unknown>, {
      app: {
        renderer: {
          resolution: 1,
          screen: { width: 1_280, height: 720 },
          resize,
        },
      },
      reels,
      anticipation,
      featurePreview: { setResponsiveLayout: vi.fn() },
      freeSpinHud: { setResponsiveLayout: vi.fn() },
      camera: { setViewportSize },
      featureEffects: {
        setResponsiveLayoutTrack: setLayoutTrack,
        setWheelOverlayRegion: vi.fn(),
      },
      bigWin: { setResponsiveLayout: vi.fn() },
      backdrop: { setResponsiveNodeTransform: vi.fn() },
      launchScene: {
        setMobileNodeTransforms: vi.fn(),
        setResponsiveTransitionLayout: vi.fn(),
      },
      gameLogo: { setResponsiveNodeTransform: vi.fn() },
      jackpotTower: { setMobileLayout: vi.fn() },
    });
    const snapshot = computeResponsiveLayoutSnapshot(1_024, 768, {
      channel: "mobile",
      pixelRatio: 1.75,
    });

    renderer.setResponsiveLayout(snapshot);

    expect(snapshot.viewportRegion).toEqual({ left: 0, top: 0, width: 844, height: 633 });
    expect(resize).toHaveBeenCalledWith(844, 633);
    expect(setViewportSize).toHaveBeenCalledWith(844, 633);
    expect(setLayoutTrack).toHaveBeenCalledWith("layout/horizontal");
    expect((renderer as unknown as {
      launchScene: { setResponsiveTransitionLayout: ReturnType<typeof vi.fn> };
    }).launchScene.setResponsiveTransitionLayout).toHaveBeenCalledWith(
      snapshot.viewportRegion,
      "ls",
    );
    expect((renderer as unknown as { app: { renderer: { resolution: number } } })
      .app.renderer.resolution).toBe(1.75);
    expect(setReelResolution).toHaveBeenCalledWith(1.75);
    expect(setAnticipationResolution).toHaveBeenCalledWith(1.75);
  });

  it("passes continuous logical dimensions to Pixi and remains idempotent after DPR quantization", () => {
    const resizeRequests: Array<Readonly<{ width: number; height: number }>> = [];
    const view = {
      width: 1_280,
      height: 720,
      style: { width: "1280px", height: "720px" },
    };
    const screen = { width: 1_280, height: 720 };
    const pixiRenderer = {
      resolution: 1,
      screen,
      view,
      resize: vi.fn((width: number, height: number) => {
        resizeRequests.push({ width, height });
        // Pixi 6.5.2 AbstractRenderer.resize 是唯一的 backing-store 量化器。
        view.width = Math.round(width * pixiRenderer.resolution);
        view.height = Math.round(height * pixiRenderer.resolution);
        screen.width = view.width / pixiRenderer.resolution;
        screen.height = view.height / pixiRenderer.resolution;
        view.style.width = `${screen.width}px`;
        view.style.height = `${screen.height}px`;
      }),
    };
    const setViewportSize = vi.fn();
    const renderer = Object.create(PixiRenderer.prototype) as PixiRenderer;
    Object.assign(renderer as unknown as Record<string, unknown>, {
      app: { renderer: pixiRenderer },
      reels: { setPerspectiveCoordinateScale: vi.fn() },
      anticipation: {
        setPerspectiveCoordinateScale: vi.fn(),
        syncToReelHost: vi.fn(),
      },
      featurePreview: { setResponsiveLayout: vi.fn() },
      freeSpinHud: { setResponsiveLayout: vi.fn() },
      camera: { setViewportSize },
      featureEffects: {
        setResponsiveLayoutTrack: vi.fn(),
        setWheelOverlayRegion: vi.fn(),
      },
      bigWin: { setResponsiveLayout: vi.fn() },
      backdrop: { setResponsiveNodeTransform: vi.fn() },
      launchScene: {
        setMobileNodeTransforms: vi.fn(),
        setResponsiveTransitionLayout: vi.fn(),
      },
      gameLogo: { setResponsiveNodeTransform: vi.fn() },
      jackpotTower: { setMobileLayout: vi.fn() },
    });
    const snapshot = computeResponsiveLayoutSnapshot(393, 852, {
      channel: "mobile",
      pixelRatio: 1.75,
    });

    renderer.setResponsiveLayout(snapshot);
    renderer.setResponsiveLayout(snapshot);

    expect(Number.isInteger(snapshot.viewportRegion.width)).toBe(false);
    expect(resizeRequests).toEqual([{
      width: snapshot.viewportRegion.width,
      height: snapshot.viewportRegion.height,
    }]);
    expect(setViewportSize).toHaveBeenLastCalledWith(
      snapshot.viewportRegion.width,
      snapshot.viewportRegion.height,
    );
    const physicalWidthError = Math.abs(
      view.width - snapshot.viewportRegion.width * pixiRenderer.resolution,
    );
    const physicalHeightError = Math.abs(
      view.height - snapshot.viewportRegion.height * pixiRenderer.resolution,
    );
    expect(physicalWidthError).toBeLessThanOrEqual(0.5);
    expect(physicalHeightError).toBeLessThanOrEqual(0.5);
    // autoDensity 直接发布量化后的逻辑 screen；应用层不再引入第二次分轴 CSS 拉伸。
    expect(Number.parseFloat(view.style.width) / screen.width).toBe(1);
    expect(Number.parseFloat(view.style.height) / screen.height).toBe(1);
  });
});
