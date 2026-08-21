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
      camera: { setViewportSize },
      featureEffects: {
        setResponsiveLayoutTrack: setLayoutTrack,
        setWheelOverlayRegion: vi.fn(),
      },
      bigWin: { setResponsiveLayout: vi.fn() },
      backdrop: { setResponsiveNodeTransform: vi.fn() },
      launchScene: { setMobileNodeTransforms: vi.fn() },
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
    expect((renderer as unknown as { app: { renderer: { resolution: number } } })
      .app.renderer.resolution).toBe(1.75);
    expect(setReelResolution).toHaveBeenCalledWith(1.75);
    expect(setAnticipationResolution).toHaveBeenCalledWith(1.75);
  });
});
