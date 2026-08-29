// @ts-nocheck -- 读取官方 JSON 资源并校验运行时投影，Node 内置类型不进入生产 tsconfig。 / English: @ts-nocheck -- Read official JSON resources and verify runtime projections. Node built-in types do not enter production tsconfig.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  mobileReelProjection,
  reelLayoutGeometry,
} from "../src/reels/ReelSetView";
import {
  JACKPOT_COMPACT_LANDSCAPE_SCALE_X,
  jackpotTierMobileLayout,
  jackpotTierMobileDisplayLayout,
  type JackpotTier,
} from "../src/renderer/JackpotTowerView";
import { logoGameMobileLayout } from "../src/renderer/LogoGameView";
import {
  computeResponsiveLayoutSnapshot,
  resolveResponsiveMinBound,
  responsiveChannelFromEnvironment,
  responsiveLayoutChannel,
} from "../src/renderer/ResponsiveLayout";

interface OfficialMobileNode {
  readonly minBound: string;
  readonly halign: string;
  readonly valign: string;
}

const officialMobileConfig = JSON.parse(readFileSync(
  new URL("../public/assets/primal-runtime/mobile/config/config_mobile.json", import.meta.url),
  "utf8",
)) as {
  bundle: Array<{
    name: string;
    data?: { layouts?: Record<string, { content: Record<string, OfficialMobileNode> }> };
  }>;
};
const officialHandLayouts = officialMobileConfig.bundle.find(({ name }) => (
  name === "layout_handmode"
))?.data?.layouts;

function officialJackpotNode(
  profile: "pt" | "iPad_pt" | "ls",
  handMode: "left" | "right",
  tier: JackpotTier,
): OfficialMobileNode {
  const node = officialHandLayouts?.[`${profile}_${handMode}`]?.content[`${tier}Panel0`];
  if (!node) throw new Error(`Missing official ${profile}_${handMode}/${tier} layout`);
  return node;
}

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

  it("uses the official mobile launcher hint only inside phone and tablet bounds", () => {
    expect(responsiveLayoutChannel(1_024, 768, {
      search: "?channel=mobile",
      coarsePointer: false,
      finePointer: true,
    })).toBe("mobile");
    expect(responsiveLayoutChannel(390, 844, {
      search: "?pid=2&channel=MOBILE&practice=1",
      coarsePointer: false,
      finePointer: true,
    })).toBe("mobile");
    expect(responsiveLayoutChannel(1_920, 1_080, {
      search: "?channel=mobile",
      finePointer: true,
    })).toBe("desktop");
    expect(responsiveLayoutChannel(1_024, 768, {
      search: "?pid=2&channel=desktop&practice=1",
      coarsePointer: true,
    })).toBe("desktop");
    expect(responsiveLayoutChannel(1_024, 768, { coarsePointer: true })).toBe("mobile");
    expect(responsiveLayoutChannel(1_024, 768, { touchPoints: 5 })).toBe("mobile");
    expect(responsiveLayoutChannel(1_920, 1_080, {
      finePointer: true,
      touchPoints: 10,
    })).toBe("desktop");
    expect(responsiveLayoutChannel(1_366, 768, {
      finePointer: true,
      touchPoints: 10,
    })).toBe("desktop");
    expect(responsiveLayoutChannel(390, 844)).toBe("mobile");
    expect(responsiveLayoutChannel(844, 390)).toBe("mobile");
    expect(responsiveLayoutChannel(1_024, 768)).toBe("desktop");
    expect(responsiveLayoutChannel(1_024, 768, { search: "?layout=mobile" })).toBe("mobile");
    expect(responsiveLayoutChannel(390, 844, { search: "?layout=desktop" })).toBe("desktop");
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
    // 同一内容最小边界在 gameplayRegion 内会居中到 y=380。 / English: The minimum bounds for the same content will be centered at y=380 within the gameplayRegion.
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

  it("continuously reflows an arbitrary tablet viewport instead of freezing 844x633", () => {
    const resized = computeResponsiveLayoutSnapshot(1_180, 820, { channel: "mobile" });
    const canonical = computeResponsiveLayoutSnapshot(844, 633, { channel: "mobile" });
    expect(resized.surfaceProfile).toBe("tablet-ls");
    expect(resized.viewportRegion).not.toEqual(canonical.viewportRegion);
    expect(resized.viewportRegion.width).toBe(844);
    expect(resized.viewportRegion.height).toBeCloseTo(844 * 820 / 1_180, 12);
    expect(resized.viewportRegion.width / resized.viewportRegion.height).toBeCloseTo(1_180 / 820, 12);
    expect(mobileReelProjection(resized.viewportRegion, resized.mobileProfile!)).not.toEqual(
      mobileReelProjection(canonical.viewportRegion, canonical.mobileProfile!),
    );
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
    const canonicalTablet = computeResponsiveLayoutSnapshot(844, 633, { channel: "mobile" });
    expect(tabletLogo).toEqual(logoGameMobileLayout(
      canonicalTablet.mobileTransforms!.logo,
      canonicalTablet.mobileProfile!,
    ));
  });

  it.each([
    { name: "phone", viewport: [390, 844] as const, profile: "pt" as const, stretchX: false },
    { name: "tablet", viewport: [633, 844] as const, profile: "iPad_pt" as const, stretchX: false },
    { name: "rotated phone", viewport: [844, 390] as const, profile: "ls" as const, stretchX: true },
    { name: "rotated tablet", viewport: [844, 633] as const, profile: "ls" as const, stretchX: false },
  ])("derives every $name jackpot transform from config_mobile.json", ({
    viewport,
    profile,
    stretchX,
  }) => {
    const [width, height] = viewport;
    const snapshot = computeResponsiveLayoutSnapshot(width, height, { channel: "mobile" });
    expect(snapshot.mobileProfile).toBe(profile);

    for (const handMode of ["left", "right"] as const) {
      for (const tier of ["grand", "mega", "major", "minor", "mini"] as const) {
        const official = officialJackpotNode(profile, handMode, tier);
        const [left, top, boundWidth, boundHeight] = official.minBound
          .split(",")
          .map(Number) as [number, number, number, number];
        const expected = resolveResponsiveMinBound(
          snapshot.gameplayRegion,
          { left, top, width: boundWidth, height: boundHeight },
          Number(official.halign),
          Number(official.valign),
        );
        const actual = jackpotTierMobileLayout(
          tier,
          profile,
          handMode,
          snapshot.gameplayRegion,
        );

        expect(actual.x).toBeCloseTo(expected.x, 10);
        expect(actual.y).toBeCloseTo(expected.y, 10);
        expect(actual.scale).toBeCloseTo(expected.scale, 10);

        const display = jackpotTierMobileDisplayLayout(
          tier,
          profile,
          handMode,
          snapshot.gameplayRegion,
        );
        expect(display.x).toBeCloseTo(expected.x, 10);
        expect(display.y).toBeCloseTo(expected.y, 10);
        expect(display.scaleY).toBeCloseTo(expected.scale, 10);
        expect(display.scaleX).toBeCloseTo(
          expected.scale * (stretchX ? JACKPOT_COMPACT_LANDSCAPE_SCALE_X : 1),
          10,
        );
      }
    }
  });
});
