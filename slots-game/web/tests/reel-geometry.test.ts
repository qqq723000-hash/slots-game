import { describe, expect, it } from "vitest";
import {
  REEL_AREA_HEIGHT,
  REEL_AREA_WIDTH,
  REEL_CELL_HEIGHT,
  REEL_STAGE_BOTTOM,
  REEL_STAGE_X,
  REEL_STAGE_Y,
  reelCellGeometry,
  reelLayoutGeometry,
  reelTransitionGeometry,
  responsiveReelCompositionScale,
  vaultCellBeforeUpgrade,
} from "../src/reels/ReelSetView";

describe("captured adaptive reel geometry", () => {
  it("does not multiply ReelSizeAnimator's settled desktop projection", () => {
    expect(responsiveReelCompositionScale(0.87)).toBe(1);
    expect(responsiveReelCompositionScale(1.05)).toBe(1);
    expect(responsiveReelCompositionScale(Number.NaN)).toBe(1);
    expect(responsiveReelCompositionScale(0)).toBe(1);
    expect(responsiveReelCompositionScale(10)).toBe(1);
  });

  it("matches the measured 1280x720 three-row reel window", () => {
    const geometry = reelLayoutGeometry(3);

    expect(REEL_STAGE_X).toBeCloseTo(427.105, 10);
    expect(REEL_STAGE_X + REEL_AREA_WIDTH).toBeCloseTo(852.895, 10);
    expect(REEL_STAGE_Y).toBeCloseTo(266.5881, 10);
    expect(REEL_STAGE_BOTTOM).toBeCloseTo(540.1881, 10);
    expect(geometry.areaHeight).toBe(REEL_AREA_HEIGHT);
    expect(geometry.areaHeight).toBeCloseTo(273.6, 10);
    expect(geometry.areaWidth).toBeCloseTo(425.79, 10);
    expect(geometry.reelWidth).toBeCloseTo(141.93, 10);
    expect(geometry.symbolWidth).toBeCloseTo(136.8, 10);
    expect(geometry.gap).toBe(0);
    expect(geometry.cellHeight).toBe(REEL_CELL_HEIGHT);
    expect(geometry.cellHeight).toBeCloseTo(91.2, 10);
    expect(geometry.stageY).toBe(REEL_STAGE_Y);
    expect(geometry.stageBottom).toBe(REEL_STAGE_BOTTOM);
    expect(geometry.stageY + geometry.areaHeight).toBeCloseTo(REEL_STAGE_BOTTOM, 10);
    expect(geometry.frameScaleX).toBeCloseTo(0.5757, 10);
    expect(geometry.frameScaleY).toBeCloseTo(0.5757, 10);
    expect(geometry.stageX + geometry.areaWidth / 2).toBeCloseTo(640, 10);
    expect(geometry.stageY + geometry.frameBaseY).toBeCloseTo(403.3881, 10);
    expect(geometry.cellTopOffset).toBe(0);
  });

  it("keeps every symbol viewport on the same root as its authored frame", () => {
    for (let rows = 3; rows <= 8; rows += 1) {
      const geometry = reelLayoutGeometry(rows);
      expect(geometry.frameScaleX).toBeCloseTo((geometry.symbolWidth / 240) * 1.01, 10);
      expect(geometry.frameScaleY).toBeCloseTo((geometry.cellHeight / 160) * 1.01, 10);
    }
  });

  it("matches the captured adaptive geometry for every expanded row count", () => {
    const expected = [
      { rows: 4, areaWidth: 470.61, reelWidth: 156.87, symbolWidth: 151.2, cellHeight: 100.8, stageX: 404.695, stageY: 137.0079, frameScale: 0.6363, frameBaseY: 252 },
      { rows: 5, areaWidth: 376.488, reelWidth: 125.496, symbolWidth: 120.96, cellHeight: 80.64, stageX: 451.756, stageY: 136.96632, frameScale: 0.50904, frameBaseY: 282.24 },
      { rows: 6, areaWidth: 313.74, reelWidth: 104.58, symbolWidth: 100.8, cellHeight: 67.2, stageX: 483.13, stageY: 136.9386, frameScale: 0.4242, frameBaseY: 302.4 },
      { rows: 7, areaWidth: 268.92, reelWidth: 89.64, symbolWidth: 86.4, cellHeight: 57.6, stageX: 505.54, stageY: 136.9188, frameScale: 0.3636, frameBaseY: 316.8 },
      { rows: 8, areaWidth: 235.305, reelWidth: 78.435, symbolWidth: 75.6, cellHeight: 50.4, stageX: 522.3475, stageY: 136.90395, frameScale: 0.31815, frameBaseY: 327.6 },
    ] as const;

    for (const sample of expected) {
      const { rows } = sample;
      const geometry = reelLayoutGeometry(rows);
      expect(geometry.areaWidth).toBeCloseTo(sample.areaWidth, 10);
      expect(geometry.reelWidth).toBeCloseTo(sample.reelWidth, 10);
      expect(geometry.symbolWidth).toBeCloseTo(sample.symbolWidth, 10);
      expect(geometry.gap).toBe(0);
      expect(geometry.cellHeight).toBeCloseTo(sample.cellHeight, 10);
      expect(geometry.areaHeight).toBeCloseTo(403.2, 10);
      expect(geometry.stageX).toBeCloseTo(sample.stageX, 10);
      expect(geometry.stageY).toBeCloseTo(sample.stageY, 10);
      expect(geometry.stageBottom).toBeCloseTo(sample.stageY + 403.2, 10);
      expect(geometry.frameScaleX).toBeCloseTo(sample.frameScale, 10);
      expect(geometry.frameScaleY).toBeCloseTo(sample.frameScale, 10);
      expect(geometry.frameHierarchyY).toBe(160 * (rows - 3));
      expect(geometry.frameBaseY).toBeCloseTo(sample.frameBaseY, 10);
      expect(geometry.cellTopOffset).toBe(0);
    }
  });

  it("linearly interpolates every visual property after caller easing", () => {
    const from = reelLayoutGeometry(3);
    const to = reelLayoutGeometry(8);
    const halfway = reelTransitionGeometry(3, 8, 0.5);

    for (const key of [
      "areaWidth", "reelWidth", "symbolWidth", "gap", "cellHeight", "areaHeight",
      "stageX", "stageY", "stageBottom", "frameScaleX", "frameScaleY",
      "frameHierarchyY", "frameBaseY",
    ] as const) {
      expect(halfway[key]).toBeCloseTo((from[key] + to[key]) / 2, 10);
    }
    expect(halfway.rows).toBe(8);
    expect(halfway.cellTopOffset).toBeCloseTo(
      halfway.areaHeight - halfway.rows * halfway.cellHeight,
      10,
    );
    expect(reelTransitionGeometry(3, 8, -1).areaWidth).toBeCloseTo(from.areaWidth, 10);
    expect(reelTransitionGeometry(3, 8, 2).areaWidth).toBeCloseTo(to.areaWidth, 10);
  });

  it("keeps effect and cell geometry aligned at every expansion height", () => {
    for (let rows = 3; rows <= 8; rows += 1) {
      const layout = reelLayoutGeometry(rows);
      const first = reelCellGeometry({ reel: 0, row: 0 }, rows);
      const last = reelCellGeometry({ reel: 2, row: rows - 1 }, rows);

      expect(first).not.toBeNull();
      expect(last).not.toBeNull();
      if (!first || !last) throw new Error("Expected in-range reel cells");
      expect(first).toMatchObject({ x: 0, y: 0 });
      expect(first.height).toBeCloseTo(layout.cellHeight, 10);
      expect(last.x + last.width).toBeCloseTo(layout.areaWidth, 10);
      expect(last.y + last.height).toBeCloseTo(layout.areaHeight, 10);
      expect(first.height).toBeCloseTo(last.height, 10);
    }
  });

  it("rejects unsupported layouts and out-of-range cell addresses", () => {
    expect(() => reelLayoutGeometry(2)).toThrow(/3-8 rows/);
    expect(() => reelLayoutGeometry(9)).toThrow(/3-8 rows/);
    expect(() => reelTransitionGeometry(2, 8, 0.5)).toThrow(/3-8 rows/);
    expect(() => reelTransitionGeometry(3, 9, 0.5)).toThrow(/3-8 rows/);
    expect(reelCellGeometry({ reel: -1, row: 0 }, 3)).toBeNull();
    expect(reelCellGeometry({ reel: 3, row: 0 }, 3)).toBeNull();
    expect(reelCellGeometry({ reel: 0, row: 3 }, 3)).toBeNull();
  });

  it("reconstructs the authoritative pre-upgrade Vault pose", () => {
    expect(vaultCellBeforeUpgrade({
      type: "vault.upgraded",
      reel: 1,
      row: 1,
      fromMultiplier: 10,
      toMultiplier: 20,
      prize: "MINI_2X",
      step: 1,
    })).toEqual({ symbol: "VAULT", multiplier: 10, prize: "MINI" });
    expect(vaultCellBeforeUpgrade({
      type: "vault.upgraded",
      reel: 1,
      row: 1,
      fromMultiplier: 7,
      toMultiplier: 9,
      prize: "X9",
      step: 1,
    })).toEqual({ symbol: "VAULT", multiplier: 7, prize: "X7" });
  });
});
