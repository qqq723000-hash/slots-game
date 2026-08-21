import { describe, expect, it } from "vitest";
import {
  RESPONSIVE_DESIGN_SURFACES,
  computeResponsiveFrameGeometry,
  computeResponsiveLayoutSnapshot,
  responsiveDesignPoint,
  responsiveDesignSurface,
  responsiveSurfaceProfile,
} from "../src/renderer/ResponsiveLayout";

describe("canonical viewport letterboxing", () => {
  it.each(Object.entries(RESPONSIVE_DESIGN_SURFACES).flatMap(([profile, surface]) => [
    { profile, kind: "exact", viewport: [surface.width, surface.height] as const, bars: false },
    { profile, kind: "wider", viewport: [surface.width + 67, surface.height] as const, bars: true },
    { profile, kind: "taller", viewport: [surface.width, surface.height + 67] as const, bars: true },
    { profile, kind: "narrower", viewport: [surface.width - 47, surface.height] as const, bars: true },
    { profile, kind: "shorter", viewport: [surface.width, surface.height - 47] as const, bars: true },
  ]))("preserves the $profile ratio in a $kind outer viewport", ({ profile, viewport, bars }) => {
    const surface = RESPONSIVE_DESIGN_SURFACES[
      profile as keyof typeof RESPONSIVE_DESIGN_SURFACES
    ];
    const geometry = computeResponsiveFrameGeometry(
      viewport[0],
      viewport[1],
      surface.width,
      surface.height,
    );

    expect(geometry.width / surface.width).toBeCloseTo(geometry.scale, 12);
    expect(geometry.height / surface.height).toBeCloseTo(geometry.scale, 12);
    expect(geometry.width / geometry.height).toBeCloseTo(surface.width / surface.height, 12);
    expect(geometry.x * 2 + geometry.width).toBeCloseTo(viewport[0], 12);
    expect(geometry.y * 2 + geometry.height).toBeCloseTo(viewport[1], 12);
    if (bars) expect(geometry.x > 0 || geometry.y > 0).toBe(true);
    else expect({ x: geometry.x, y: geometry.y, scale: geometry.scale }).toEqual({
      x: 0,
      y: 0,
      scale: 1,
    });
  });

  it.each([
    {
      name: "desktop exact",
      viewport: [1_280, 720] as const,
      design: [1_280, 720] as const,
      expected: { x: 0, y: 0, scale: 1 },
    },
    {
      name: "desktop taller",
      viewport: [1_440, 900] as const,
      design: [1_280, 720] as const,
      expected: { x: 0, y: 45, scale: 1.125 },
    },
    {
      name: "desktop narrow",
      viewport: [768, 900] as const,
      design: [1_280, 720] as const,
      expected: { x: 0, y: 234, scale: 0.6 },
    },
    {
      name: "phone portrait wider",
      viewport: [430, 844] as const,
      design: [390, 844] as const,
      expected: { x: 20, y: 0, scale: 1 },
    },
    {
      name: "tablet landscape taller",
      viewport: [844, 700] as const,
      design: [844, 633] as const,
      expected: { x: 0, y: 33.5, scale: 1 },
    },
  ])("contains and centres the $name surface", ({ viewport, design, expected }) => {
    const geometry = computeResponsiveFrameGeometry(
      viewport[0],
      viewport[1],
      design[0],
      design[1],
    );

    expect(geometry).toMatchObject(expected);
    expect(geometry.designWidth).toBe(design[0]);
    expect(geometry.designHeight).toBe(design[1]);
    expect(geometry.width / geometry.height).toBeCloseTo(design[0] / design[1], 12);
    expect(geometry.width).toBeLessThanOrEqual(viewport[0]);
    expect(geometry.height).toBeLessThanOrEqual(viewport[1]);
    expect(geometry.x * 2 + geometry.width).toBeCloseTo(viewport[0], 12);
    expect(geometry.y * 2 + geometry.height).toBeCloseTo(viewport[1], 12);
    expect(geometry.visibleInsetX).toBe(0);
  });

  it.each([
    { viewport: [390, 844] as const, channel: "mobile" as const, profile: "phone-pt" },
    { viewport: [844, 390] as const, channel: "mobile" as const, profile: "phone-ls" },
    { viewport: [633, 844] as const, channel: "mobile" as const, profile: "tablet-pt" },
    { viewport: [844, 633] as const, channel: "mobile" as const, profile: "tablet-ls" },
    { viewport: [599, 1_000] as const, channel: "mobile" as const, profile: "phone-pt" },
    { viewport: [600, 1_000] as const, channel: "mobile" as const, profile: "tablet-pt" },
    { viewport: [390, 844] as const, channel: "desktop" as const, profile: "desktop" },
  ])("selects $profile for $viewport", ({ viewport, channel, profile }) => {
    expect(responsiveSurfaceProfile(viewport[0], viewport[1], channel)).toBe(profile);
  });

  it.each([
    [430, 932],
    [412, 915],
    [820, 1_180],
    [1_180, 820],
    [834, 1_113],
    [1_113, 834],
  ])("derives a continuous mobile design surface for an arbitrary %sx%s viewport", (
    physicalWidth,
    physicalHeight,
  ) => {
    const snapshot = computeResponsiveLayoutSnapshot(physicalWidth, physicalHeight, {
      channel: "mobile",
    });

    expect(snapshot.physicalViewportRegion).toEqual({
      left: 0,
      top: 0,
      width: physicalWidth,
      height: physicalHeight,
    });
    expect(snapshot.viewportRegion.width / snapshot.viewportRegion.height).toBeCloseTo(
      physicalWidth / physicalHeight,
      12,
    );
    expect(snapshot.frame.x).toBe(0);
    expect(snapshot.frame.y).toBe(0);
    expect(snapshot.frame.width).toBeCloseTo(physicalWidth, 12);
    expect(snapshot.frame.height).toBeCloseTo(physicalHeight, 12);
    expect(snapshot.frame.width / snapshot.viewportRegion.width).toBeCloseTo(
      snapshot.frame.height / snapshot.viewportRegion.height,
      12,
    );
  });

  it("uses the five captured sizes as exact calibration points, not the only canvases", () => {
    for (const [profile, reference] of Object.entries(RESPONSIVE_DESIGN_SURFACES)) {
      const channel = profile === "desktop" ? "desktop" : "mobile";
      expect(responsiveDesignSurface(reference.width, reference.height, channel)).toEqual({
        width: reference.width,
        height: reference.height,
      });
    }
  });

  it("clamps only pathological mobile aspect ratios and keeps their bars outside input", () => {
    const snapshot = computeResponsiveLayoutSnapshot(240, 1_000, { channel: "mobile" });

    expect(snapshot.viewportRegion.width / snapshot.viewportRegion.height).toBeCloseTo(9 / 22, 12);
    expect(snapshot.frame.x).toBe(0);
    expect(snapshot.frame.y).toBeGreaterThan(0);
    expect(snapshot.frame.width).toBeCloseTo(240, 12);
    expect(snapshot.frame.height).toBeLessThan(1_000);
    expect(responsiveDesignPoint(snapshot.frame, 120, snapshot.frame.y - 0.01)).toBeNull();
    expect(responsiveDesignPoint(snapshot.frame, 120, snapshot.frame.y)).toEqual({
      x: snapshot.viewportRegion.width / 2,
      y: 0,
    });
  });

  it("maps only the rendered surface back to canonical coordinates", () => {
    const frame = computeResponsiveFrameGeometry(1_440, 900, 1_280, 720);

    expect(responsiveDesignPoint(frame, 720, 450)).toEqual({ x: 640, y: 360 });
    expect(responsiveDesignPoint(frame, 0, 45)).toEqual({ x: 0, y: 0 });
    expect(responsiveDesignPoint(frame, 1_440, 855)).toEqual({ x: 1_280, y: 720 });
    expect(responsiveDesignPoint(frame, 720, 44.99)).toBeNull();
    expect(responsiveDesignPoint(frame, 720, 855.01)).toBeNull();
  });
});
