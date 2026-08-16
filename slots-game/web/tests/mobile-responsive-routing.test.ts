import { describe, expect, it } from "vitest";
import {
  mobileReelProjection,
  reelLayoutGeometry,
} from "../src/reels/ReelSetView";
import {
  jackpotTierMobileLayout,
  type JackpotTier,
} from "../src/renderer/JackpotTowerView";
import { logoGameMobileLayout } from "../src/renderer/LogoGameView";
import {
  computeResponsiveLayoutSnapshot,
  responsiveChannelFromEnvironment,
} from "../src/renderer/ResponsiveLayout";

describe("mobile channel routing", () => {
  it("lets an explicit launcher query override pointer capability", () => {
    expect(responsiveChannelFromEnvironment({
      search: "?pid=2&channel=desktop&practice=1",
      coarsePointer: true,
    })).toBe("desktop");
    expect(responsiveChannelFromEnvironment({
      search: "?channel=MOBILE",
      coarsePointer: false,
    })).toBe("mobile");
  });

  it("falls back to coarse-pointer capability when the query has no valid channel", () => {
    expect(responsiveChannelFromEnvironment({ coarsePointer: true })).toBe("mobile");
    expect(responsiveChannelFromEnvironment({
      search: "?channel=television",
      coarsePointer: false,
    })).toBe("desktop");
    expect(responsiveChannelFromEnvironment()).toBe("desktop");
  });
});

describe("mobile renderer projection contracts", () => {
  it("resolves Feature Preview against the complete viewport, not the status-trimmed game region", () => {
    const snapshot = computeResponsiveLayoutSnapshot(390, 844, { channel: "mobile" });

    expect(snapshot.viewportRegion).toEqual({ left: 0, top: 0, width: 390, height: 844 });
    expect(snapshot.gameplayRegion).toEqual({ left: 0, top: 0, width: 390, height: 760 });
    expect(snapshot.fpsTransforms?.content).toEqual({ x: 195, y: 422, scale: 0.39 });
    expect(snapshot.fpsTransforms?.background).toEqual({
      x: 195,
      y: 422,
      scale: 0.4875,
    });
    expect(snapshot.fpsTransforms?.blackOverlay).toEqual({ x: 195, y: 422, scale: 0.39 });
    expect(snapshot.fpsTransforms?.logo).toEqual({ x: 195, y: 227, scale: 0.4875 });
    // 同一内容最小边界在 gameplayRegion 内会居中到 y=380。
    expect(snapshot.fpsTransforms?.content.y).not.toBe(380);
  });

  it.each([
    {
      name: "390x844 portrait phone",
      viewport: [390, 844] as const,
      expected: { x: 24.375, y: 312.593644578313, scale: 0.801451419714 },
    },
    {
      name: "844x390 landscape phone",
      viewport: [844, 390] as const,
      expected: { x: 285.4390625, y: 117.12065625, scale: 0.641447368421 },
    },
    {
      name: "1024x768 landscape tablet",
      viewport: [1_024, 768] as const,
      expected: { x: 288, y: 288.326425702811, scale: 1.05216186383 },
    },
  ])("projects the cabinet at $name", ({ viewport: [width, height], expected }) => {
    const snapshot = computeResponsiveLayoutSnapshot(width, height, { channel: "mobile" });
    const profile = snapshot.mobileProfile;
    if (!profile) throw new Error("Expected a mobile reel profile");

    const geometry = reelLayoutGeometry(3);
    const projection = mobileReelProjection(snapshot.viewportRegion, profile);
    expect(projection.x).toBeCloseTo(expected.x, 10);
    expect(projection.y).toBeCloseTo(expected.y, 10);
    expect(projection.scale).toBeCloseTo(expected.scale, 10);
    expect(geometry.areaWidth * projection.scale).toBeGreaterThan(0);
  });

  it("applies the captured portrait logo correction and tablet landscape shift", () => {
    const portrait = computeResponsiveLayoutSnapshot(390, 844, { channel: "mobile" });
    const portraitLogo = logoGameMobileLayout(
      portrait.mobileTransforms!.logo,
      portrait.mobileProfile!,
    );
    expect(portraitLogo.x).toBeCloseTo(-211.466666666667, 10);
    expect(portraitLogo.y).toBeCloseTo(603.331333333333, 10);
    expect(portraitLogo.scale).toBeCloseTo(0.489666666667, 10);

    const phoneLandscape = computeResponsiveLayoutSnapshot(844, 390, { channel: "mobile" });
    const phoneLogo = logoGameMobileLayout(
      phoneLandscape.mobileTransforms!.logo,
      phoneLandscape.mobileProfile!,
    );
    expect(phoneLogo).toEqual({ x: -137.64, y: 44.64, scale: 0.372 });

    const tablet = computeResponsiveLayoutSnapshot(1_024, 768, { channel: "mobile" });
    const tabletLogo = logoGameMobileLayout(
      tablet.mobileTransforms!.logo,
      tablet.mobileProfile!,
    );
    expect(tabletLogo.x).toBeCloseTo(-238.628571428571, 10);
    expect(tabletLogo.y).toBeCloseTo(103.057142857143, 10);
    expect(tabletLogo.scale).toBeCloseTo(0.731428571429, 10);
  });

  it("keeps the five portrait jackpot tiers in their captured two-row arrangement", () => {
    const snapshot = computeResponsiveLayoutSnapshot(390, 844, { channel: "mobile" });
    const expected: Readonly<Record<JackpotTier, readonly [number, number, number]>> = {
      grand: [195, 39, 0.557142857143],
      mega: [56.0625, 39, 0.4875],
      major: [331.5, 39, 0.4875],
      minor: [49.4, 95.333333333333, 0.433333333333],
      mini: [337.566666666667, 95.333333333333, 0.433333333333],
    };

    for (const tier of Object.keys(expected) as JackpotTier[]) {
      const right = jackpotTierMobileLayout(tier, "pt", "right", snapshot.gameplayRegion);
      const left = jackpotTierMobileLayout(tier, "pt", "left", snapshot.gameplayRegion);
      const [x, y, scale] = expected[tier];
      expect(right.x).toBeCloseTo(x, 10);
      expect(right.y).toBeCloseTo(y, 10);
      expect(right.scale).toBeCloseTo(scale, 10);
      expect(left).toEqual(right);
    }
  });

  it("routes the landscape jackpot stack to the side selected by hand mode", () => {
    const snapshot = computeResponsiveLayoutSnapshot(844, 390, { channel: "mobile" });
    const expected = {
      grand: { rightX: 97.133333333333, leftX: 745.626666666667, y: 132.28, scale: 0.462933333333 },
      mega: { rightX: 96.72, leftX: 745.792, y: 178.56, scale: 0.41664 },
      major: { rightX: 96.381818181818, leftX: 745.250909090909, y: 219.818181818182, scale: 0.378763636364 },
      minor: { rightX: 96.1, leftX: 746.35, y: 257.3, scale: 0.3472 },
      mini: { rightX: 95.861538461538, leftX: 746.707692307692, y: 291.876923076923, scale: 0.320492307692 },
    } satisfies Readonly<Record<JackpotTier, {
      readonly rightX: number;
      readonly leftX: number;
      readonly y: number;
      readonly scale: number;
    }>>;

    for (const tier of Object.keys(expected) as JackpotTier[]) {
      const right = jackpotTierMobileLayout(tier, "ls", "right", snapshot.gameplayRegion);
      const left = jackpotTierMobileLayout(tier, "ls", "left", snapshot.gameplayRegion);
      expect(right.x).toBeCloseTo(expected[tier].rightX, 10);
      expect(left.x).toBeCloseTo(expected[tier].leftX, 10);
      expect(right.y).toBeCloseTo(expected[tier].y, 10);
      expect(left.y).toBeCloseTo(expected[tier].y, 10);
      expect(right.scale).toBeCloseTo(expected[tier].scale, 10);
      expect(left.scale).toBeCloseTo(expected[tier].scale, 10);
    }
  });
});
