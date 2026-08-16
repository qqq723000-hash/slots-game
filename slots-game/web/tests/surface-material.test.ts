import { describe, expect, it } from "vitest";
import {
  sampleBrushedSteel,
  sampleEdgeWear,
  sampleScratches,
  seededSurfaceValue,
  type SurfaceStroke,
} from "../src/renderer/surfaceMaterial";

const expectStrokeInBounds = (stroke: SurfaceStroke, width: number, height: number): void => {
  expect(stroke.x1).toBeGreaterThanOrEqual(0);
  expect(stroke.x1).toBeLessThanOrEqual(width);
  expect(stroke.x2).toBeGreaterThanOrEqual(0);
  expect(stroke.x2).toBeLessThanOrEqual(width);
  expect(stroke.y1).toBeGreaterThanOrEqual(0);
  expect(stroke.y1).toBeLessThanOrEqual(height);
  expect(stroke.y2).toBeGreaterThanOrEqual(0);
  expect(stroke.y2).toBeLessThanOrEqual(height);
  expect(stroke.width).toBeGreaterThan(0);
  expect(stroke.alpha).toBeGreaterThanOrEqual(0);
  expect(stroke.alpha).toBeLessThanOrEqual(1);
};

describe("surface material sampling", () => {
  it("keeps the stateless seed sampler deterministic and bounded", () => {
    const first = Array.from({ length: 32 }, (_, index) => seededSurfaceValue(0x51ee1, index));
    const second = Array.from({ length: 32 }, (_, index) => seededSurfaceValue(0x51ee1, index));

    expect(second).toEqual(first);
    expect(first.every((value) => value >= 0 && value < 1)).toBe(true);
    expect(Array.from({ length: 32 }, (_, index) => seededSurfaceValue(0x51ee2, index))).not.toEqual(first);
  });

  it("returns deterministic brushed steel and scratch geometry inside the surface", () => {
    const options = { seed: 731, width: 580, height: 42, count: 48, direction: "horizontal" as const };
    const brushed = sampleBrushedSteel(options);
    const scratches = sampleScratches({ ...options, count: 12 });

    expect(sampleBrushedSteel(options)).toEqual(brushed);
    expect(sampleScratches({ ...options, count: 12 })).toEqual(scratches);
    expect(brushed).toHaveLength(48);
    expect(scratches).toHaveLength(12);
    [...brushed, ...scratches].forEach((stroke) => expectStrokeInBounds(stroke, options.width, options.height));
    scratches.forEach((scratch) => {
      expect(scratch.depth).toBeGreaterThanOrEqual(0);
      expect(scratch.depth).toBeLessThanOrEqual(1);
    });
  });

  it("places exposed metal only inside the declared edge band", () => {
    const width = 420;
    const height = 180;
    const edgeBand = 9;
    const wear = sampleEdgeWear({ seed: 0xcab1, width, height, count: 96 }, edgeBand);

    expect(new Set(wear.map((mark) => mark.edge))).toEqual(new Set(["top", "right", "bottom", "left"]));
    wear.forEach((mark) => {
      expectStrokeInBounds(mark, width, height);
      expect(mark.exposure).toBeGreaterThan(0);
      expect(mark.exposure).toBeLessThanOrEqual(1);
      if (mark.edge === "top") expect(Math.max(mark.y1, mark.y2)).toBeLessThanOrEqual(edgeBand);
      if (mark.edge === "bottom") expect(Math.min(mark.y1, mark.y2)).toBeGreaterThanOrEqual(height - edgeBand);
      if (mark.edge === "left") expect(Math.max(mark.x1, mark.x2)).toBeLessThanOrEqual(edgeBand);
      if (mark.edge === "right") expect(Math.min(mark.x1, mark.x2)).toBeGreaterThanOrEqual(width - edgeBand);
    });
  });

  it("rejects invalid or unbounded requests", () => {
    expect(() => sampleBrushedSteel({ seed: 1, width: 0, height: 20, count: 1 })).toThrow(RangeError);
    expect(() => sampleScratches({ seed: 1, width: 20, height: Number.NaN, count: 1 })).toThrow(RangeError);
    expect(() => sampleEdgeWear({ seed: 1, width: 20, height: 20, count: 2_049 })).toThrow(RangeError);
    expect(() => sampleEdgeWear({ seed: 1, width: 20, height: 20, count: 1 }, 0)).toThrow(RangeError);
  });

  it("keeps edge wear bounded on very small valid surfaces", () => {
    const width = 0.4;
    const height = 0.25;
    const wear = sampleEdgeWear({ seed: 91, width, height, count: 12 }, 0.08);

    wear.forEach((mark) => expectStrokeInBounds(mark, width, height));
  });
});
