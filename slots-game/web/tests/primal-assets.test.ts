import { describe, expect, it } from "vitest";
import {
  CHARACTER_REGIONS,
  ENERGY_FRAME_GRID,
  ENVIRONMENT_REGIONS,
  ENVIRONMENT_VIEW,
  PRIMAL_ASSETS,
  PRIMAL_LOGO_REGION,
  SYMBOL_ASSET_BY_ID,
  WILD_MULTIPLIER_ASSETS,
  wildAssetForMultiplier,
} from "../src/assets/PrimalAssetManifest";
import { SYMBOL_IDS } from "../src/app/state/types";

describe("Primal Rampage asset manifest", () => {
  it("maps every protocol symbol to one supplied runtime image", () => {
    expect(Object.keys(SYMBOL_ASSET_BY_ID).sort()).toEqual([...SYMBOL_IDS].sort());
    expect(new Set(Object.values(SYMBOL_ASSET_BY_ID)).size).toBe(SYMBOL_IDS.length);
    Object.values(SYMBOL_ASSET_BY_ID).forEach((url) => {
      expect(url).toMatch(/^\/assets\/primal-reference\/\d+\.png$/);
    });
    expect(SYMBOL_ASSET_BY_ID.PRISM).toBe(PRIMAL_ASSETS.symbols.q);
    expect(SYMBOL_ASSET_BY_ID.ORBIT).toBe(PRIMAL_ASSETS.symbols.k);
  });

  it("selects the authored Wild art for every supported multiplier", () => {
    expect(wildAssetForMultiplier(undefined)).toBe(PRIMAL_ASSETS.symbols.wild);
    const supported = [
      [2, PRIMAL_ASSETS.symbols.wildX2],
      [3, PRIMAL_ASSETS.symbols.wildX3],
      [5, PRIMAL_ASSETS.symbols.wildX5],
      [10, PRIMAL_ASSETS.symbols.wildX10],
      [25, PRIMAL_ASSETS.symbols.wildX25],
      [50, PRIMAL_ASSETS.symbols.wildX50],
      [100, PRIMAL_ASSETS.symbols.wildX100],
    ] as const;

    for (const [multiplier, asset] of supported) {
      expect(wildAssetForMultiplier(multiplier)).toBe(asset);
      expect(WILD_MULTIPLIER_ASSETS).toContain(asset);
    }
    expect(PRIMAL_ASSETS.symbols.wildX50).toBe("/assets/primal-reference/wild-x50.png");
    expect(new Set(WILD_MULTIPLIER_ASSETS).size).toBe(supported.length);
  });

  it("keeps camera, logo and energy frames inside their measured atlases", () => {
    expect(ENVIRONMENT_REGIONS.daylight.x + ENVIRONMENT_REGIONS.daylight.width).toBeLessThanOrEqual(4_065);
    expect(ENVIRONMENT_REGIONS.destroyed.x + ENVIRONMENT_REGIONS.destroyed.width).toBeLessThanOrEqual(4_065);
    expect(ENVIRONMENT_REGIONS.daylight.height).toBe(2_676);
    expect(ENVIRONMENT_REGIONS.destroyed.height).toBe(2_676);
    expect(PRIMAL_LOGO_REGION.x + PRIMAL_LOGO_REGION.width).toBeLessThanOrEqual(996);
    expect(PRIMAL_LOGO_REGION.y + PRIMAL_LOGO_REGION.height).toBeLessThanOrEqual(1_632);
    expect(ENERGY_FRAME_GRID.loopLastFrame).toBeLessThan(ENERGY_FRAME_GRID.columns * ENERGY_FRAME_GRID.rows);
    expect(ENERGY_FRAME_GRID.firstVisibleFrame).toBeLessThan(ENERGY_FRAME_GRID.revealLastFrame);
    expect(ENERGY_FRAME_GRID.revealLastFrame).toBeLessThan(ENERGY_FRAME_GRID.loopFirstFrame);
  });

  it("keeps character cutouts and camera stops inside their source plates", () => {
    const characterAtlas = { width: 3_649, height: 3_076 };
    for (const region of Object.values(CHARACTER_REGIONS)) {
      expect(region.x).toBeGreaterThanOrEqual(0);
      expect(region.y).toBeGreaterThanOrEqual(0);
      expect(region.width).toBeGreaterThan(0);
      expect(region.height).toBeGreaterThan(0);
      expect(region.x + region.width).toBeLessThanOrEqual(characterAtlas.width);
      expect(region.y + region.height).toBeLessThanOrEqual(characterAtlas.height);
    }

    expect(CHARACTER_REGIONS.torso).toEqual({ x: 0, y: 2_200, width: 420, height: 490 });
    expect(CHARACTER_REGIONS.head).toEqual({ x: 2_525, y: 1_788, width: 180, height: 165 });
    expect(ENVIRONMENT_VIEW.expandedSourceY).toBe(0);
    expect(ENVIRONMENT_VIEW.baseSourceY).toBe(720);
    for (const sourceY of Object.values(ENVIRONMENT_VIEW)) {
      expect(sourceY).toBeGreaterThanOrEqual(0);
      expect(sourceY).toBeLessThan(ENVIRONMENT_REGIONS.daylight.height);
      expect(sourceY).toBeLessThan(ENVIRONMENT_REGIONS.destroyed.height);
    }
    expect(ENVIRONMENT_VIEW.expandedSourceY).toBeLessThan(ENVIRONMENT_VIEW.baseSourceY);
  });
});
